import { Router } from 'express';
import { changeAddressPrefix } from '@likecoin/iscn-js/dist/iscn/addressParsing';
import Multer from 'multer';
import RateLimit from 'express-rate-limit';
import {
  PUBSUB_TOPIC_MISC,
  TEST_MODE,
} from '../../constant';
import {
  userCollection as dbRef,
} from '../../util/firebase';
import {
  getAuthCoreUser,
  updateAuthCoreUserById,
  createAuthCoreCosmosWalletViaUserToken,
} from '../../util/authcore';
import {
  checkCosmosSignPayload,
  setAuthCookies,
  clearAuthCookies,
  userOrWalletByEmailQuery,
  normalizeUserEmail,
  getUserAgentIsApp,
  checkEVMSignPayload,
} from '../../util/api/users';
import { handleUserRegistration } from '../../util/api/users/register';
import { handleAppReferrer, handleUpdateAppMetaData } from '../../util/api/users/app';
import { ValidationError } from '../../util/ValidationError';
import { handleAvatarUploadAndGetURL } from '../../util/fileupload';
import { jwtAuth } from '../../middleware/jwt';
import { authCoreJwtSignToken, authCoreJwtVerify } from '../../util/jwt';
import publisher from '../../util/gcloudPub';
import {
  REGISTER_LIMIT_WINDOW,
  REGISTER_LIMIT_COUNT,
} from '../../../config/config';

import {
  isValidLikeAddress,
} from '../../util/cosmos';
import { getMagicUserMetadataByDIDToken, verifyEmailByMagicUserMetadata } from '../../util/magic';

export const THIRTY_S_IN_MS = 30000;

const multer = Multer({
  storage: Multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // no larger than 5mb, you can change as needed.
  },
});

const router = Router();

const apiLimiter = RateLimit({
  windowMs: REGISTER_LIMIT_WINDOW,
  max: REGISTER_LIMIT_COUNT || 0,
  skipFailedRequests: true,
  keyGenerator: (req) => (req.headers['x-real-ip'] as string || req.ip),
  onLimitReached: (req) => {
    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'eventAPILimitReached',
    });
  },
});

function isJson(req) {
  return !!req.is('application/json');
}

function isApp(req) {
  const { 'user-agent': userAgent = '' } = req.headers;
  return userAgent.includes('LikeCoinApp');
}

function formdataParserForApp(req, res, next) {
  if (!isJson(req)) {
    if (isApp(req)) {
      multer.none()(req, res, next);
    } else {
      next(new ValidationError('INVALID_CONTENT_TYPE'));
    }
  } else {
    next();
  }
}

router.post(
  '/new',
  formdataParserForApp,
  apiLimiter,
  async (req, res, next) => {
    const {
      platform,
      appReferrer,
      user,
      displayName,
      description,
    } = req.body;
    let email;
    try {
      let payload;
      switch (platform) {
        case 'evmWallet': {
          const {
            from: inputWallet,
            payload: stringPayload,
            sign,
            magicDIDToken,
          } = req.body;
          checkEVMSignPayload({
            signature: sign,
            message: stringPayload,
            inputWallet,
            action: 'register',
          });
          payload = req.body;
          payload.evmWallet = inputWallet;
          payload.displayName = displayName || user;
          ({ email } = req.body);
          payload.isEmailVerified = false;
          if (magicDIDToken) {
            const magicUserMetadata = await getMagicUserMetadataByDIDToken(magicDIDToken);
            payload.magicUserId = magicUserMetadata.issuer;
            if (!verifyEmailByMagicUserMetadata(email, magicUserMetadata)) {
              throw new ValidationError('MAGIC_EMAIL_MISMATCH');
            }
            payload.isEmailVerified = true;
          }
          payload.email = email;
          break;
        }
        case 'authcore': {
          const {
            idToken,
            accessToken,
          } = req.body;
          if (!idToken) throw new ValidationError('ID_TOKEN_MISSING');
          if (!accessToken) throw new ValidationError('ACCESS_TOKEN_MISSING');
          let authCoreUser;
          try {
            authCoreUser = authCoreJwtVerify(idToken);
            if (!authCoreUser) throw new ValidationError('AUTHCORE_USER_NOT_EXIST');
          } catch (err) {
            throw new ValidationError('ID_TOKEN_INVALID');
          }

          const {
            sub: authCoreUserId,
            email: authCoreEmail,
            email_verified: isAuthCoreEmailVerified,
            phone_number: authCorePhone,
            phone_number_verified: isAuthCorePhoneVerified,
          } = authCoreUser;
          payload = req.body;
          payload.authCoreUserId = authCoreUserId;
          if (!payload.cosmosWallet) {
            try {
              const cosmosWallet = await createAuthCoreCosmosWalletViaUserToken(accessToken);
              payload.cosmosWallet = cosmosWallet;
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('Cannot create cosmos wallet');
              // eslint-disable-next-line no-console
              console.error(err);
              throw new ValidationError('COSMOS_WALLET_PENDING');
            }
          }
          if (!payload.likeWallet && payload.cosmosWallet) {
            try {
              const likeWallet = await changeAddressPrefix(payload.cosmosWallet, 'like');
              payload.likeWallet = likeWallet;
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('Cannot create cosmos wallet');
              // eslint-disable-next-line no-console
              console.error(err);
              throw new ValidationError('COSMOS_WALLET_PENDING');
            }
          }
          email = authCoreEmail;
          // TODO: remove this displayname hack after authcore fix default name privacy issue
          payload.displayName = user;
          payload.email = email;
          payload.isEmailVerified = isAuthCoreEmailVerified;
          if (authCorePhone) {
            payload.phone = authCorePhone;
            payload.isPhoneVerified = isAuthCorePhoneVerified;
          }
          break;
        }
        case 'likeWallet': {
          const {
            from: inputWallet, signature, publicKey, message, signMethod,
          } = req.body;
          ({ email } = req.body);
          if (!inputWallet || !signature || !publicKey || !message) throw new ValidationError('INVALID_PAYLOAD');
          if (platform === 'likeWallet' && !isValidLikeAddress(inputWallet)) throw new ValidationError('INVALID_LIKE_ADDRESS');
          if (!checkCosmosSignPayload({
            signature, publicKey, message, inputWallet, signMethod,
          })) {
            throw new ValidationError('INVALID_SIGN');
          }
          payload = req.body;
          payload.cosmosWallet = changeAddressPrefix(inputWallet, 'cosmos');
          payload.likeWallet = changeAddressPrefix(inputWallet, 'like');
          payload.displayName = displayName || user;
          payload.email = email;
          payload.isEmailVerified = false;
          break;
        }
        default:
          throw new ValidationError('INVALID_PLATFORM');
      }
      const {
        userPayload,
      } = await handleUserRegistration({
        payload: {
          ...payload,
          description,
          platform,
        },
        req,
        res,
      });

      if (platform === 'authcore' && !TEST_MODE) {
        try {
          const authCoreToken = await authCoreJwtSignToken();
          await updateAuthCoreUserById(
            payload.authCoreUserId,
            {
              user,
              displayName: payload.displayName || user,
            },
            authCoreToken,
          );
        } catch (err) {
          /* no update will return 400 error */
          if (!(err as any).response || (err as any).response.status !== 400) {
            // eslint-disable-next-line no-console
            console.error(err);
          }
        }
      }

      await setAuthCookies(req, res, { user, platform });
      res.sendStatus(200);
      publisher.publish(PUBSUB_TOPIC_MISC, req, {
        ...userPayload,
        logType: 'eventUserRegister',
      });
      if (getUserAgentIsApp(req)) {
        if (appReferrer) {
          await handleAppReferrer(req, userPayload, appReferrer);
        } else {
          await handleUpdateAppMetaData(req, userPayload);
        }
      }
    } catch (err) {
      publisher.publish(PUBSUB_TOPIC_MISC, req, {
        logType: 'eventRegisterError',
        platform,
        user,
        email,
        error: (err as Error).message || JSON.stringify(err),
      });
      next(err);
    }
  },
);

router.post(
  '/update',
  jwtAuth('write'),
  async (req, res, next) => {
    try {
      const { user } = req.user;
      const {
        email,
        displayName,
        description,
        locale,
      } = req.body;
      let { isEmailEnabled } = req.body;

      // handle isEmailEnable is string
      if (typeof isEmailEnabled === 'string') {
        isEmailEnabled = isEmailEnabled !== 'false';
      }
      const oldUserObj = await dbRef.doc(user).get();
      const {
        wallet,
        referrer,
        avatar,
        timestamp,
        displayName: oldDisplayName,
        email: oldEmail,
        locale: oldLocale,
        authCoreUserId,
      } = oldUserObj.data();

      const updateObj: any = {
        displayName,
        description,
        isEmailEnabled,
        locale,
      };

      if (email) {
        if (authCoreUserId && oldEmail) throw new ValidationError('EMAIL_CANNOT_BE_CHANGED');
        await userOrWalletByEmailQuery({ user }, email);
        const {
          normalizedEmail,
          isEmailBlacklisted,
          isEmailDuplicated,
        } = await normalizeUserEmail(user, email);
        if (normalizedEmail) {
          updateObj.email = email;
          updateObj.normalizedEmail = normalizedEmail;
          updateObj.isEmailVerified = false;
        } else {
          throw new ValidationError('EMAIL_FORMAT_INCORRECT');
        }
        if (isEmailBlacklisted !== undefined) updateObj.isEmailBlacklisted = isEmailBlacklisted;
        if (isEmailDuplicated !== undefined) updateObj.isEmailDuplicated = isEmailDuplicated;
      }

      Object.keys(updateObj).forEach((key) => {
        if (updateObj[key] === undefined) {
          delete updateObj[key];
        }
      });

      if (!Object.keys(updateObj).length) {
        throw new ValidationError('INVALID_PAYLOAD');
      }
      await dbRef.doc(user).update(updateObj);
      res.sendStatus(200);

      publisher.publish(PUBSUB_TOPIC_MISC, req, {
        logType: 'eventUserUpdate',
        user,
        ...updateObj,
        email: email || oldEmail,
        displayName: displayName || oldDisplayName,
        wallet,
        avatar,
        referrer,
        locale: locale || oldLocale,
        registerTime: timestamp,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/update/avatar',
  jwtAuth('write'),
  multer.single('avatarFile'),
  async (req, res, next) => {
    try {
      const { user } = req.user;
      const { avatarSHA256 } = req.body;
      const { file } = req;
      let avatarUrl;
      let avatarHash;
      if (!file) throw new ValidationError('MISSING_AVATAR_FILE');
      try {
        ({
          url: avatarUrl,
          hash: avatarHash,
        } = await handleAvatarUploadAndGetURL(user, file, avatarSHA256));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Avatar file handling error:');
        // eslint-disable-next-line no-console
        console.error(err);
        throw new ValidationError('INVALID_AVATAR');
      }

      const payload: any = { avatar: avatarUrl };
      if (avatarHash) payload.avatarHash = avatarHash;
      await dbRef.doc(user).update(payload);
      res.json({ avatar: avatarUrl });

      const oldUserObj = await dbRef.doc(user).get();
      const {
        wallet,
        referrer,
        timestamp,
        displayName,
        email,
        locale,
      } = oldUserObj.data();
      publisher.publish(PUBSUB_TOPIC_MISC, req, {
        logType: 'eventUserAvatarUpdate',
        user,
        wallet,
        referrer,
        displayName,
        email,
        locale,
        avatar: avatarUrl,
        registerTime: timestamp,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/sync/authcore', jwtAuth('write'), async (req, res, next) => {
  try {
    const { user } = req.user;
    const {
      authCoreAccessToken,
    } = req.body;
    const {
      email,
      displayName,
      isEmailVerified,
      phone,
      isPhoneVerified,
    } = await getAuthCoreUser(authCoreAccessToken);
    const updateObj: any = {
      email,
      displayName,
      isEmailVerified,
      phone,
      isPhoneVerified,
    };
    if (email) {
      const {
        normalizedEmail,
        isEmailBlacklisted,
        isEmailDuplicated,
      } = await normalizeUserEmail(user, email);
      if (normalizedEmail) updateObj.normalizedEmail = normalizedEmail;
      if (isEmailBlacklisted !== undefined) updateObj.isEmailBlacklisted = isEmailBlacklisted;
      if (isEmailDuplicated !== undefined) updateObj.isEmailDuplicated = isEmailDuplicated;
    }
    await dbRef.doc(user).update(updateObj);
    res.sendStatus(200);

    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'eventUserSync',
      type: 'authcore',
      user,
      ...updateObj,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    let user;
    let wallet;
    let authCoreUserName;
    let authCoreUserId;
    const {
      platform,
      appReferrer,
      sourceURL,
      utmSource,
    } = req.body;

    switch (platform) {
      case 'evmWallet': {
        const {
          from,
          payload: stringPayload,
          sign,
        } = req.body;
        wallet = from;
        checkEVMSignPayload({
          signature: sign,
          message: stringPayload,
          inputWallet: wallet,
          action: 'login',
        });
        const userQuery = await (
          dbRef
            .where('evmWallet', '==', wallet)
            .get()
        );
        if (userQuery.docs.length > 0) {
          const [userDoc] = userQuery.docs;
          user = userDoc.id;
        }
        break;
      }
      case 'likeWallet': {
        const {
          from: inputWallet, signature, publicKey, message, signMethod,
        } = req.body;
        if (!inputWallet || !signature || !publicKey || !message) throw new ValidationError('INVALID_PAYLOAD');
        if (platform === 'likeWallet' && !isValidLikeAddress(inputWallet)) throw new ValidationError('INVALID_LIKE_ADDRESS');
        if (!checkCosmosSignPayload({
          signature, publicKey, message, inputWallet, signMethod,
        })) {
          throw new ValidationError('INVALID_SIGN');
        }
        const userQuery = await (
          dbRef
            .where('likeWallet', '==', inputWallet)
            .get()
        );
        if (userQuery.docs.length > 0) {
          const [userDoc] = userQuery.docs;
          user = userDoc.id;
        }
        break;
      }
      case 'authcore': {
        const { idToken } = req.body;
        if (!idToken) throw new ValidationError('ID_TOKEN_MISSING');
        const authCoreUser = authCoreJwtVerify(idToken);
        ({
          sub: authCoreUserId,
          /* TODO: remove after most lazy update of user id is done */
          preferred_username: authCoreUserName,
        } = authCoreUser);
        const userQuery = await (
          dbRef
            .where('authCoreUserId', '==', authCoreUserId)
            .get()
        );
        if (userQuery.docs.length > 0) {
          const [userDoc] = userQuery.docs;
          user = userDoc.id;
        }
        break;
      }
      default:
        throw new ValidationError('INVALID_PLATFORM');
    }

    if (user) {
      const doc = await dbRef.doc(user).get();
      if (doc.exists) {
        const {
          isLocked,
        } = doc.data();
        if (isLocked) {
          // eslint-disable-next-line no-console
          console.log(`Locked user: ${user}`);
          throw new ValidationError('USER_LOCKED');
        }
      }
      await setAuthCookies(req, res, { user, platform });
      res.sendStatus(200);

      if (doc.exists) {
        const {
          email,
          displayName,
          referrer,
          locale,
          cosmosWallet,
          likeWallet,
          timestamp: registerTime,
        } = doc.data();
        if (platform === 'authcore' && req.body.accessToken && !TEST_MODE) {
          const { accessToken } = req.body;
          if (!cosmosWallet) {
            const newWallet = await createAuthCoreCosmosWalletViaUserToken(accessToken);
            const newLikeWallet = changeAddressPrefix(newWallet, 'like');
            await dbRef.doc(user).update({ cosmosWallet: newWallet, likeWallet: newLikeWallet });
          }
          if (!likeWallet && cosmosWallet) {
            const newLikeWallet = changeAddressPrefix(cosmosWallet, 'like');
            await dbRef.doc(user).update({ likeWallet: newLikeWallet });
          }
          if (!authCoreUserName) {
            try {
              const authCoreToken = await authCoreJwtSignToken();
              await updateAuthCoreUserById(
                authCoreUserId,
                {
                  user,
                  displayName,
                },
                authCoreToken,
              );
            } catch (err) {
              /* no update will return 400 error */
              if (!(err as any).response || (err as any).response.status !== 400) {
                // eslint-disable-next-line no-console
                console.error(err);
              }
            }
          }
        }
        publisher.publish(PUBSUB_TOPIC_MISC, req, {
          logType: 'eventUserLogin',
          user,
          email,
          displayName,
          wallet,
          referrer,
          locale,
          registerTime,
          platform,
          sourceURL,
          utmSource,
        });
      }
      if (getUserAgentIsApp(req)) {
        const userObject = { user, ...doc.data() };
        if (appReferrer) {
          await handleAppReferrer(req, userObject, appReferrer);
        } else {
          await handleUpdateAppMetaData(req, userObject);
        }
      }
    } else {
      res.sendStatus(404);
    }
  } catch (err) {
    next(err);
  }
});

router.post('/logout', jwtAuth('read'), async (req, res, next) => {
  try {
    const { user, jti } = req.user;

    clearAuthCookies(req, res);
    res.sendStatus(200);

    if (user) {
      try {
        await dbRef.doc(user).collection('session').doc(jti).delete();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err);
      }
      const doc = await dbRef.doc(user).get();
      if (doc.exists) {
        const {
          wallet,
          email,
          displayName,
          referrer,
          locale,
          timestamp: registerTime,
        } = doc.data();
        publisher.publish(PUBSUB_TOPIC_MISC, req, {
          logType: 'eventUserLogout',
          user,
          email,
          displayName,
          wallet,
          referrer,
          locale,
          registerTime,
        });
      }
    }
  } catch (err) {
    next(err);
  }
});

export default router;
