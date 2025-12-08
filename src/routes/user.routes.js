import { Router } from 'express';
import { authRequired } from '../middlewares/auth.middleware.js';
import multer from 'multer';
import {
  getMyProfile,
  getUserProfile,
  updateMyProfile,
  uploadAvatar,
} from '../controllers/user.controller.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/me', authRequired, getMyProfile);
router.patch('/me', authRequired, updateMyProfile);
router.post('/me/avatar', authRequired, upload.single('file'), uploadAvatar);
router.get('/:id', authRequired, getUserProfile);

export default router;
