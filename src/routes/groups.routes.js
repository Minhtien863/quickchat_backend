// src/routes/groups.routes.js
import { Router } from 'express';
import multer from 'multer';
import { authRequired } from '../middlewares/auth.middleware.js';
import {
  createGroup,
  listGroupMembers,
  addGroupMembers,
  updateMemberRole,
  updateMemberSendPermission,
  removeMember,
  transferGroupOwnership,
  leaveGroup,
  updateGroupInfo,
  updateGroupAvatar,
} from '../controllers/groups.controller.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/groups  (avatar là tuỳ chọn)
router.post('/', authRequired, upload.single('avatar'), createGroup);
// Cập nhật thông tin nhóm (tên / mô tả)
router.patch('/:conversationId', authRequired, updateGroupInfo);

// Cập nhật avatar nhóm
router.patch(
  '/:conversationId/avatar',
  authRequired,
  upload.single('avatar'),
  updateGroupAvatar,
);

// === THÀNH VIÊN NHÓM ===

// Lấy danh sách thành viên
router.get('/:conversationId/members', authRequired, listGroupMembers);

// Thêm thành viên vào nhóm
router.post('/:conversationId/members', authRequired, addGroupMembers);

// Cập nhật vai trò (owner/admin/member)
router.patch(
  '/:conversationId/members/:userId/role',
  authRequired,
  updateMemberRole,
);

// Bật/tắt quyền gửi tin (canSend)
router.patch(
  '/:conversationId/members/:userId/can-send',
  authRequired,
  updateMemberSendPermission,
);

// Xóa thành viên khỏi nhóm
router.delete(
  '/:conversationId/members/:userId',
  authRequired,
  removeMember,
);

// Nhường quyền chủ nhóm
router.post(
  '/:conversationId/transfer-owner',
  authRequired,
  transferGroupOwnership,
);

router.post(
  '/conversations/:conversationId/leave',
  authRequired,
  leaveGroup,
);

export default router;
