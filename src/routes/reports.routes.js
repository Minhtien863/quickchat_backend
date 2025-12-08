// src/routes/reports.routes.js
import { Router } from 'express';
import { authRequired } from '../middlewares/auth.middleware.js';
import { touchLastSeen } from '../middlewares/lastSeen.middleware.js';
import { createReport, getMyReport } from '../controllers/reports.controller.js'; 
const router = Router();

router.use(authRequired, touchLastSeen);

// gửi báo cáo
router.post('/', createReport);

// xem chi tiết 1 báo cáo của chính mình
router.get('/:id', getMyReport);
export default router;