import { Router } from 'express';
import BigNumber from 'bignumber.js';
import {
  GETTING_STARTED_TASKS,
  PUBSUB_TOPIC_MISC,
} from '../../constant';
import {
  filterMissionData,
} from '../../util/ValidationHelper';
import { ValidationError } from '../../util/ValidationError';
import publisher from '../../util/gcloudPub';
import { jwtAuth } from '../../util/jwt';
import {
  userCollection as dbRef,
  missionCollection as missionsRef,
} from '../../util/firebase';

const ONE_LIKE = new BigNumber(10).pow(18);

const router = Router();

async function checkAlreadyDone(m, { u, doneList }) {
  const { id } = m;
  const mission = m.data();
  const username = u.id;
  const user = u.data();
  let isDone = false;
  switch (id) {
    case 'verifyEmail': {
      if (user.isEmailVerified) isDone = true;
      break;
    }
    case 'inviteFriend': {
      const query = await u.ref.collection('referrals').where('isEmailVerified', '==', true).get();
      if (query.docs.length) isDone = true;
      break;
    }
    case 'refereeTokenSale': {
      if (!user.referrer) return false;
      const query = await u.ref.collection('referrals').where('isICO', '==', true).get();
      if (query.docs.length) isDone = true;
      break;
    }
    default: return false;
  }
  if (!isDone) return false;
  const payload = { done: true };
  doneList.push(id);
  if (!mission.reward || mission.staying) payload.bonusId = 'none';
  await dbRef.doc(username).collection('mission').doc(id).set(payload, { merge: true });
  return (!mission.staying && !mission.reward);
}

router.get('/list/:id', jwtAuth('read'), async (req, res, next) => {
  try {
    const username = req.params.id;
    if (req.user.user !== username) {
      res.status(401).send('LOGIN_NEEDED');
      return;
    }
    const [missionCol, userDoc] = await Promise.all([
      missionsRef.orderBy('priority').get(),
      dbRef.doc(username).get(),
    ]);
    if (!userDoc.exists) throw new ValidationError('user not exist');
    const userMissionCol = await dbRef.doc(username).collection('mission').get();
    const proxyMissions = missionCol.docs.reduce((accu, m) => {
      if (m.data().isProxy) accu[m.id] = true; // eslint-disable-line no-param-reassign
      return accu;
    }, {});
    const userMisionList = userMissionCol.docs.map(d => d.id);
    const missionDone = userMissionCol.docs.filter(d => d.data().done).map(d => d.id);

    const replyMissionList = userMissionCol.docs
      .filter(d => (!d.data().bonusId || proxyMissions[d.id]))
      .map(d => ({ id: d.id, ...d.data() }));
    for (let index = 0; index < missionCol.docs.length; index += 1) {
      const m = missionCol.docs[index];
      const missionData = m.data();

      if (missionData.startTs && Date.now() < missionData.startTs) {
        missionData.upcoming = missionData.startTs;
      }
      const notExpired = !missionData.endTs || Date.now() < missionData.endTs;

      if (!userMisionList.includes(m.id)) {
        const requires = missionData.require;
        const fulfilled = requires.every(id => missionDone.includes(id));
        if (fulfilled
          && notExpired
          && (!missionData.isRefereeOnly || userDoc.data().referrer)
          // eslint-disable-next-line no-await-in-loop
          && !(await checkAlreadyDone(m, { u: userDoc, doneList: missionDone }))) {
          replyMissionList.push({ id: m.id, ...missionData });
        }
      } else {
        const targetIndex = replyMissionList.findIndex(d => d.id === m.id);
        if (targetIndex >= 0) {
          if (!notExpired && (!missionDone.includes(m.id) && !m.data().isProxy)) {
            replyMissionList.splice(targetIndex, 1);
          } else {
            replyMissionList[targetIndex] = Object.assign(
              missionData,
              replyMissionList[targetIndex],
            );
          }
        } else if (notExpired && missionData.staying) {
          replyMissionList.push({ id: m.id, ...missionData });
        }
      }
    }
    const missions = replyMissionList.map(d => ({ ...filterMissionData(d) }));
    res.json(missions);
  } catch (err) {
    next(err);
  }
});

router.post('/seen/:id', jwtAuth('write'), async (req, res, next) => {
  try {
    const missionId = req.params.id;
    const {
      user,
    } = req.body;
    if (req.user.user !== user) {
      res.status(401).send('LOGIN_NEEDED');
      return;
    }
    const userMissionRef = dbRef.doc(user).collection('mission').doc(missionId);
    await userMissionRef.set({ seen: true }, { merge: true });
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});


router.post('/hide/:id', jwtAuth('write'), async (req, res, next) => {
  try {
    const missionId = req.params.id;
    const {
      user,
    } = req.body;
    if (req.user.user !== user) {
      res.status(401).send('LOGIN_NEEDED');
      return;
    }
    const missionDoc = await missionsRef.doc(missionId).get();
    if (!missionDoc.exists) throw new ValidationError('mission unknown');
    const {
      isHidable,
      isHidableAfterDone,
    } = missionDoc.data();
    const userMissionRef = dbRef.doc(user).collection('mission').doc(missionId);
    const userMissionDoc = await userMissionRef.get();
    if (!userMissionDoc) throw new ValidationError('user mission not exist');
    const {
      done,
    } = userMissionDoc.data();
    if (!isHidable && !(isHidableAfterDone && done)) throw new ValidationError('mission not hidable');
    await userMissionRef.set({ hide: true }, { merge: true });
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

router.post('/step/:id', jwtAuth('write'), async (req, res, next) => {
  try {
    const missionId = req.params.id;
    const {
      user,
      taskId,
    } = req.body;
    if (req.user.user !== user) {
      res.status(401).send('LOGIN_NEEDED');
      return;
    }
    const userMissionRef = dbRef.doc(user).collection('mission').doc(missionId);
    const doc = await userMissionRef.get();
    let done = false;
    switch (missionId) {
      case 'gettingStart': {
        if (!GETTING_STARTED_TASKS.includes(taskId)) throw new ValidationError('task unknown');
        const doneTasks = [taskId, ...Object.keys(doc.data())];
        done = GETTING_STARTED_TASKS.every(t => doneTasks.includes(t));
        break;
      }
      default: throw new ValidationError('mission unknown');
    }
    const payload = { [taskId]: true };
    if (done) payload.done = true;
    await userMissionRef.set(payload, { merge: true });
    res.json(payload);
    const userDoc = await dbRef.doc(user).get();
    const {
      email,
      displayName,
      wallet,
      referrer,
      locale,
      timestamp: registerTime,
    } = userDoc.data();
    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'eventMissionStep',
      user,
      email: email || undefined,
      displayName,
      wallet,
      referrer: referrer || undefined,
      locale,
      missionId,
      taskId,
      missionDone: done,
      registerTime,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/list/history/:id', jwtAuth('read'), async (req, res, next) => {
  try {
    const username = req.params.id;
    if (req.user.user !== username) {
      res.status(401).send('LOGIN_NEEDED');
      return;
    }
    const userDoc = await dbRef.doc(username).get();
    if (!userDoc.exists) throw new ValidationError('user not exist');
    const [userMissionCol, missionCol] = await Promise.all([
      dbRef.doc(username).collection('mission').get(),
      missionsRef.orderBy('priority').get(),
    ]);
    const doneList = userMissionCol.docs
      .filter(d => d.data().done).map(d => ({ id: d.id, ...d.data() }));

    for (let index = 0; index < doneList.length; index += 1) {
      const mission = missionCol.docs.find(m => (m.id === doneList[index].id));
      doneList[index] = Object.assign({}, { ...mission.data(), ...doneList[index] });
    }
    const missions = doneList.map(d => ({ ...filterMissionData(d) }));
    res.json(missions);
  } catch (err) {
    next(err);
  }
});

router.get('/list/history/:id/bonus', jwtAuth('read'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (req.user.user !== id) {
      res.status(401).send('LOGIN_NEEDED');
      return;
    }
    const query = await dbRef.doc(id).collection('bonus').get();
    const obj = query.docs
      .filter(t => t.data().txHash && t.data().value)
      .reduce((acc, t) => {
        const { value, type } = t.data();
        if (!acc[type]) acc[type] = new BigNumber(0);
        acc[type] = acc[type].plus(new BigNumber(value));
        return acc;
      }, {});
    Object.keys(obj).forEach((key) => {
      obj[key] = obj[key].dividedBy(ONE_LIKE).toFixed(4);
    });
    res.json(obj);
  } catch (err) {
    next(err);
  }
});

router.get('/:missionId/user/:userId', jwtAuth('read'), async (req, res, next) => {
  try {
    const { missionId, userId } = req.params;
    const { userMissionList = [] } = req.query;
    if (req.user.user !== userId) {
      res.status(401).send('LOGIN_NEEDED');
      return;
    }

    // retrieve whole mission doc to trace back required mission chain
    const [missionCol, userMission] = await Promise.all([
      missionsRef.get(),
      dbRef.doc(userId).collection('mission').doc(missionId).get(),
    ]);

    const getMission = id => missionCol.docs.find(d => d.id === id);

    const mission = getMission(missionId);
    if (!mission) {
      res.json({ isExpired: true });
      return;
    }

    const missionData = mission.data();
    const userMissionData = userMission.data();

    const isExpired = !!missionData.endTs && Date.now() >= missionData.endTs;
    const isClaimed = userMissionData
      ? (userMissionData.done && !!userMissionData.bonusId)
      : false;
    const isMissionRequired = !userMissionData;

    const require = [];
    // get the required mission that has to be fulfilled first by user
    if (isMissionRequired) {
      let requiredMissions = missionData.require;
      while (requiredMissions && requiredMissions.length > 0) {
        // filter mission that is available to user
        const userExistingMission = requiredMissions.filter(m => userMissionList.includes(m))[0];
        if (!userExistingMission) {
          requiredMissions = getMission(requiredMissions[0]).data().require;
        } else {
          require.push(userExistingMission);
          requiredMissions = [];
        }
      }
    }

    res.json({
      ...filterMissionData({
        id: missionId,
        ...missionData,
        ...userMissionData,
      }),
      isExpired,
      isClaimed,
      isMissionRequired,
      require,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
