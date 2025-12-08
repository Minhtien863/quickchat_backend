// src/routes/hidden.routes.js
import { Router } from 'express';
import { authRequired } from '../middlewares/auth.middleware.js';
import {
  getDirectStatus,
  getConversationStatus,
  hideConversation,
  unhideConversation,
  setupHiddenPin,
  verifyHiddenPin,
  clearHiddenPinAndData,
  getHiddenPinStatus,
} from '../controllers/hidden.controller.js';

const router = Router();

router.use(authRequired);

// GET /api/hidden/direct-status?otherUserId=...
router.get('/direct-status', getDirectStatus);

// GET /api/hidden/conversations/:conversationId/status
router.get('/conversations/:conversationId/status', getConversationStatus);

// POST /api/hidden/conversations/:conversationId/hide
router.post('/conversations/:conversationId/hide', hideConversation);

// DELETE /api/hidden/conversations/:conversationId/hide
router.delete('/conversations/:conversationId/hide', unhideConversation);

// PIN
router.post('/pin', setupHiddenPin);
router.post('/pin/verify', verifyHiddenPin);
router.get('/pin/status', getHiddenPinStatus); 
router.delete('/pin', clearHiddenPinAndData);
export default router;