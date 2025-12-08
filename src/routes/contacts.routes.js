import { Router } from 'express';
import { authRequired } from '../middlewares/auth.middleware.js';
import {
  listFriends,
  listReceivedInvites,
  listSentInvites,
  sendInvite,
  acceptInvite,
  declineInvite,
  cancelSentInvite,
  findUsersForInvite,
  getRelationWithUser,
  listGroups,
  blockUser,
  unblockUser,
  removeFriend,
  listBlockedUsers,
  getMyPrivacySettings,
  updateMyPrivacySettings,
} from '../controllers/contacts.controller.js';

const router = Router();

router.use(authRequired);

router.get('/friends', listFriends);
router.delete('/friends/:id', removeFriend);
router.get('/search-users', findUsersForInvite);

router.get('/invites/received', listReceivedInvites);
router.get('/invites/sent', listSentInvites);

router.post('/invites', sendInvite);
router.post('/invites/:id/accept', acceptInvite);
router.post('/invites/:id/decline', declineInvite);
router.post('/invites/:id/cancel', cancelSentInvite);
router.get('/relation/:id', getRelationWithUser);
// BLOCK
router.post('/block/:id', blockUser);
router.post('/unblock/:id', unblockUser);
router.get('/blocks', listBlockedUsers);

//GROUPS
router.get('/groups', listGroups);

// Privacy
router.get('/privacy', getMyPrivacySettings);
router.patch('/privacy', updateMyPrivacySettings);


export default router;
