// src/routes/chat.routes.js
import { Router } from 'express';
import { authRequired } from '../middlewares/auth.middleware.js';
import {
  listMessages,
  sendText,
  addReaction,
  removeReaction,
  forwardMessages,
  revokeMessage,
  deleteMessage,
  pinMessage,
  unpinMessage,
  uploadMessageMedia,
  sendMedia,
  getConversationPeer,

  scheduleMessage,
  listScheduledMessages,
  cancelScheduledMessage,
  rescheduleScheduledMessage,
  sendScheduledNow,
  deleteConversation
} from '../controllers/chat.controller.js';
import multer from 'multer';
import { touchLastSeen } from '../middlewares/lastSeen.middleware.js';

const router = Router();

router.use(authRequired, touchLastSeen);

router.get('/conversations/:conversationId/messages', listMessages);
router.post('/conversations/:conversationId/messages', sendText);

// POST /api/chat/conversations/:conversationId/scheduled
router.post(
  '/conversations/:conversationId/scheduled',
  scheduleMessage,
);

router.delete('/conversations/:conversationId', deleteConversation);

// GET /api/chat/scheduled?conversationId=...
router.get('/scheduled', listScheduledMessages);

// DELETE /api/chat/scheduled/:scheduledId
router.delete('/scheduled/:scheduledId', cancelScheduledMessage);

// PATCH /api/chat/scheduled/:scheduledId
router.patch('/scheduled/:scheduledId', rescheduleScheduledMessage);

// POST /api/chat/scheduled/:scheduledId/send-now
router.post('/scheduled/:scheduledId/send-now', sendScheduledNow);

router.post('/messages/:messageId/reactions', addReaction);
router.delete('/messages/:messageId/reactions', removeReaction);

router.post('/messages/forward', forwardMessages);

// THÊM CÁC ROUTE KHỚP VỚI Flutter
// Thu hồi (delete for everyone)
router.post('/messages/:messageId/revoke', revokeMessage);

// Xóa (tạm thời hard-delete, chỉ cho người gửi)
router.delete('/messages/:messageId', deleteMessage);

// Ghim / bỏ ghim
router.post('/messages/:messageId/pin', pinMessage);
router.delete('/messages/:messageId/pin', unpinMessage);

const upload = multer({
   storage: multer.memoryStorage(),
   limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// upload file media dùng cho tin nhắn
router.post(
  '/messages/upload',
  upload.single('file'),
  uploadMessageMedia,
);
// gửi message có asset (image/video)
router.post(
  '/conversations/:conversationId/messages/media',
  sendMedia,
);

router.get('/conversations/:conversationId/peer', getConversationPeer);

export default router;