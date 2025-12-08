import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';

import authRoutes from './routes/auth.routes.js';
import chatRoutes from './routes/chat.routes.js';
import userRoutes from './routes/user.routes.js';
import contactsRoutes from './routes/contacts.routes.js';
import searchRoutes from './routes/search.routes.js';
import hiddenRoutes from './routes/hidden.routes.js';
import groupsRoutes from './routes/groups.routes.js';
import conversationsRoutes from './routes/conversations.routes.js';

import { verifyEmailTransport } from './services/email.service.js';
import { attachSocket } from './socket/index.js';
import notesRoutes from './routes/notes.routes.js';
import pushRoutes from './routes/push.routes.js';
import { startScheduledMessageWorker } from './controllers/chat.controller.js';
import adminRoutes from './routes/admin.routes.js';
import reportsRoutes from './routes/reports.routes.js';
import adminReportsRoutes from './routes/admin_reports.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';

await verifyEmailTransport();

const app = express();
const PORT = process.env.PORT || 4000;

startScheduledMessageWorker();
// middlewares chung
app.use(cors());
app.use(express.json());

// health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// routes HTTP
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/users', userRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/chat', conversationsRoutes);
app.use('/api/hidden', hiddenRoutes);
// Notifications
app.use('/api/notifications', notificationsRoutes);
// TẠO HTTP SERVER + SOCKET.IO 
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: '*',              
    methods: ['GET', 'POST'],
  },
});

// gắn middleware socket
attachSocket(io);

app.use('/api/notes', notesRoutes);

app.use('/api/push', pushRoutes);

// Admin
app.use('/api/admin', adminRoutes);

app.use('/api/reports', reportsRoutes);
app.use('/api/admin/reports', adminReportsRoutes);

// start server
server.listen(PORT, () => {
  console.log(`Backend QuickChat đang chạy ở port ${PORT}`);
});
