    // src/routes/admin_reports.routes.js
    import { Router } from 'express';
    import { authRequired, adminOnly } from '../middlewares/auth.middleware.js';
    import { adminListReports, adminGetReport, adminUpdateReport } from '../controllers/admin_reports.controller.js';

    const router = Router();

    router.use(authRequired, adminOnly);

    router.get('/', adminListReports);
    router.get('/:id', adminGetReport);
    router.patch('/:id', adminUpdateReport);

    export default router;