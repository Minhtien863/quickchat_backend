// src/routes/admin.routes.js
import { Router } from 'express';
import { authRequired, adminOnly } from '../middlewares/auth.middleware.js';
import { pool } from '../db.js';
import { sendForceLogoutToUser } from '../services/fcm.service.js';


const router = Router();

// Các giá trị hợp lệ của user_status
const USER_STATUS_VALUES = ['active', 'banned', 'locked', 'self_deleted'];
const GROUP_STATUS_VALUES = ['active', 'locked', 'banned'];

// GET /api/admin/me  -> thông tin admin đang đăng nhập
router.get('/me', authRequired, adminOnly, async (req, res) => {
  try {
    const q = `
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.username,
        u.created_at,
        a.url AS avatar_url
      FROM users u
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE u.id = $1
    `;
    const r = await pool.query(q, [req.user.sub]);
    if (!r.rowCount) {
      return res.status(404).json({ message: 'Không tìm thấy user' });
    }
    return res.json({ admin: r.rows[0] });
  } catch (err) {
    console.error('/api/admin/me error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

// GET /api/admin/users?status=&q=&limit=&offset=
router.get('/users', authRequired, adminOnly, async (req, res) => {
  try {
    const { status, q, limit, offset } = req.query;

    const pageSize = Math.min(parseInt(limit ?? '20', 10) || 20, 100);
    const pageOffset = parseInt(offset ?? '0', 10) || 0;

    const params = [];
    const where = [];

    // Lọc theo status nếu hợp lệ và khác 'all'
    if (status && status !== 'all') {
      const s = String(status);
      if (!USER_STATUS_VALUES.includes(s)) {
        return res
          .status(400)
          .json({ message: 'Trạng thái lọc không hợp lệ' });
      }
      params.push(s);
      where.push(`u.status = $${params.length}`);
    }

    // Tìm kiếm theo tên / email / username
    if (q && String(q).trim() !== '') {
      params.push(`%${String(q).trim().toLowerCase()}%`);
      const i = params.length;
      where.push(`(
        LOWER(u.display_name) LIKE $${i}
        OR LOWER(u.email) LIKE $${i}
        OR LOWER(u.username) LIKE $${i}
      )`);
    }

    const whereSql = where.length ? where.join(' AND ') : '1=1';

    // Loại admin khỏi list
    const finalWhere = `${whereSql} AND u.id NOT IN (SELECT user_id FROM admins)`;

    params.push(pageSize);
    const iLimit = params.length;
    params.push(pageOffset);
    const iOffset = params.length;

    const listSql = `
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.username,
        u.phone,
        u.status,
        u.is_email_verified,
        u.created_at,
        u.last_seen_at,
        a.url AS avatar_url
      FROM users u
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE ${finalWhere}
      ORDER BY u.created_at DESC
      LIMIT $${iLimit} OFFSET $${iOffset}
    `;
    const listRes = await pool.query(listSql, params);

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users u WHERE ${finalWhere}`,
      params.slice(0, params.length - 2),
    );

    return res.json({
      items: listRes.rows,
      total: countRes.rows[0].total,
      limit: pageSize,
      offset: pageOffset,
    });
  } catch (err) {
    console.error('/api/admin/users error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

// GET /api/admin/users/:id  -> chi tiết 1 user cho admin
router.get('/users/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const q = `
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.username,
        u.about,
        to_char(u.birthday, 'YYYY-MM-DD') AS birthday,
        u.phone,
        u.status,
        u.is_email_verified,
        u.created_at,
        u.last_seen_at,
        (SELECT url FROM assets WHERE id = u.avatar_asset_id) AS avatar_url
      FROM users u
      WHERE u.id = $1
    `;
    const r = await pool.query(q, [id]);
    if (!r.rowCount) {
      return res.status(404).json({ message: 'Không tìm thấy user' });
    }
    return res.json({ user: r.rows[0] });
  } catch (err) {
    console.error('/api/admin/users/:id error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

// PATCH /api/admin/users/:id/status  -> ban/lock/unlock + FORCE LOGOUT
router.patch(
  '/users/:id/status',
  authRequired,
  adminOnly,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { status } = req.body || {};

      const allowed = ['active', 'banned', 'locked'];
      if (!allowed.includes(status)) {
        client.release();
        return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
      }

      // Không cho tự khóa chính mình thành banned/locked
      if (id === req.user.sub && status !== 'active') {
        client.release();
        return res
          .status(400)
          .json({ message: 'Không thể tự khoá tài khoản quản trị' });
      }

      // Không cho đổi trạng thái tài khoản admin
      const adminCheck = await pool.query(
        'SELECT 1 FROM admins WHERE user_id = $1',
        [id],
      );
      if (adminCheck.rowCount > 0) {
        client.release();
        return res.status(400).json({
          message: 'Không thể thay đổi trạng thái tài khoản admin',
        });
      }

      await client.query('BEGIN');

      // Lấy trạng thái cũ để xem có cần force_logout không
      const curRes = await client.query(
        `
        SELECT status
        FROM users
        WHERE id = $1
        FOR UPDATE
        `,
        [id],
      );
      if (!curRes.rowCount) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ message: 'Không tìm thấy user' });
      }
      const oldStatus = curRes.rows[0].status;

      // Cập nhật status + bump token_version để revoke tất cả phiên
      const upd = await client.query(
        `
        UPDATE users
        SET status = $1,
            token_version = token_version + 1,
            updated_at = now()
        WHERE id = $2
        RETURNING
          id,
          email,
          display_name,
          username,
          phone,
          status,
          is_email_verified,
          created_at,
          last_seen_at
        `,
        [status, id],
      );

      // Đánh dấu tất cả device của user là inactive (để không nhận push chat/call nữa)
      await client.query(
        `
        UPDATE user_devices
        SET is_active = false
        WHERE user_id = $1
        `,
        [id],
      );

      await client.query('COMMIT');
      client.release();

      if (!upd.rowCount) {
        return res.status(404).json({ message: 'Không tìm thấy user' });
      }

      const updatedUser = upd.rows[0];

      // Nếu từ active -> locked/banned thì bắn FCM force_logout
      if (
        oldStatus === 'active' &&
        (status === 'locked' || status === 'banned')
      ) {
        let reason = '';
        let msg =
          'Tài khoản của bạn đã bị thay đổi trạng thái bởi quản trị viên.';

        if (status === 'locked') {
          reason = 'admin_user_locked';
          msg =
            'Tài khoản của bạn đã bị tạm khoá do vi phạm quy tắc sử dụng. ' +
            'Mọi thắc mắc, khiếu nại vui lòng liên hệ 2124801040041@student.tdmu.edu.vn.';
        } else if (status === 'banned') {
          reason = 'admin_user_banned';
          msg =
            'Tài khoản của bạn đã bị cấm vĩnh viễn do vi phạm nghiêm trọng. ' +
            'Mọi thắc mắc, khiếu nại vui lòng liên hệ 2124801040041@student.tdmu.edu.vn.';
        }

        try {
          await sendForceLogoutToUser({
            userId: id,
            reason,
            message: msg,
          });
        } catch (e) {
          console.error('[ADMIN] sendForceLogoutToUser error:', e);
        }
      }

      return res.json({ user: updatedUser });
    } catch (err) {
      await pool.query('ROLLBACK').catch(() => {});
      console.error('/api/admin/users/:id/status error:', err);
      return res.status(500).json({ message: 'Lỗi server' });
    }
  },
);

// ==== GROUPS (giữ nguyên như cũ) ====

router.get('/groups', authRequired, adminOnly, async (req, res) => {
  try {
    const { q, limit, offset } = req.query;
    const pageSize = Math.min(parseInt(limit ?? '20', 10) || 20, 100);
    const pageOffset = parseInt(offset ?? '0', 10) || 0;

    const params = [];
    const where = [`c.type = 'group'`];

    if (q && String(q).trim() !== '') {
      params.push(`%${String(q).trim().toLowerCase()}%`);
      const i = params.length;
      where.push(`LOWER(gp.name) LIKE $${i}`);
    }

    const whereSql = where.length ? where.join(' AND ') : '1=1';

    params.push(pageSize);
    const iLimit = params.length;
    params.push(pageOffset);
    const iOffset = params.length;

    const listSql = `
      SELECT
        c.id,
        gp.name,
        gp.description,
        c.created_at,
        c.status,
        COUNT(cm.user_id)::int AS member_count,
        owner_u.id   AS owner_id,
        owner_u.display_name AS owner_display_name,
        owner_u.email        AS owner_email,
        a.url AS avatar_url
      FROM conversations c
      JOIN group_profiles gp
        ON gp.conversation_id = c.id
      LEFT JOIN conversation_members cm
        ON cm.conversation_id = c.id
      LEFT JOIN LATERAL (
        SELECT u.id, u.display_name, u.email
        FROM conversation_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.conversation_id = c.id
          AND m.role = 'owner'
        LIMIT 1
      ) AS owner_u ON TRUE
      LEFT JOIN assets a
        ON a.id = COALESCE(gp.avatar_asset_id, c.avatar_asset_id)
      WHERE ${whereSql}
      GROUP BY
        c.id,
        gp.name,
        gp.description,
        c.created_at,
        c.status,
        owner_u.id,
        owner_u.display_name,
        owner_u.email,
        a.url
      ORDER BY c.created_at DESC
      LIMIT $${iLimit} OFFSET $${iOffset}
    `;

    const listRes = await pool.query(listSql, params);

    const countRes = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM conversations c
      JOIN group_profiles gp
        ON gp.conversation_id = c.id
      WHERE ${whereSql}
      `,
      params.slice(0, params.length - 2),
    );

    return res.json({
      items: listRes.rows,
      total: countRes.rows[0].total,
      limit: pageSize,
      offset: pageOffset,
    });
  } catch (err) {
    console.error('/api/admin/groups error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

router.get('/groups/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const q = `
      SELECT
        c.id,
        c.created_at,
        c.status,
        gp.name,
        gp.description,
        COUNT(cm.user_id)::int AS member_count,
        owner_u.id   AS owner_id,
        owner_u.display_name AS owner_display_name,
        owner_u.email        AS owner_email
      FROM conversations c
      JOIN group_profiles gp
        ON gp.conversation_id = c.id
      LEFT JOIN conversation_members cm
        ON cm.conversation_id = c.id
      LEFT JOIN LATERAL (
        SELECT u.id, u.display_name, u.email
        FROM conversation_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.conversation_id = c.id
          AND m.role = 'owner'
        LIMIT 1
      ) AS owner_u ON TRUE
      WHERE c.id = $1 AND c.type = 'group'
      GROUP BY
        c.id,
        c.created_at,
        c.status,
        gp.name,
        gp.description,
        owner_u.id,
        owner_u.display_name,
        owner_u.email
    `;

    const r = await pool.query(q, [id]);
    if (!r.rowCount) {
      return res.status(404).json({ message: 'Không tìm thấy nhóm' });
    }

    return res.json({ group: r.rows[0] });
  } catch (err) {
    console.error('/api/admin/groups/:id error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

router.patch(
  '/groups/:id/status',
  authRequired,
  adminOnly,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { status } = req.body || {};

      if (!GROUP_STATUS_VALUES.includes(status)) {
        client.release();
        return res
          .status(400)
          .json({ message: 'Trạng thái nhóm không hợp lệ' });
      }

      await client.query('BEGIN');

      const convRes = await client.query(
        `SELECT id, type, status
       FROM conversations
       WHERE id = $1`,
        [id],
      );
      if (!convRes.rowCount) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ message: 'Không tìm thấy nhóm' });
      }
      const conv = convRes.rows[0];
      if (conv.type !== 'group') {
        await client.query('ROLLBACK');
        client.release();
        return res
          .status(400)
          .json({ message: 'Hội thoại này không phải nhóm' });
      }

      if (status === 'banned') {
        await client.query(
          `DELETE FROM messages WHERE conversation_id = $1`,
          [id],
        );
      }

      await client.query(
        `UPDATE conversations
       SET status = $2
       WHERE id = $1`,
        [id, status],
      );

      const detailSql = `
      SELECT
        c.id,
        c.created_at,
        c.status,
        gp.name,
        gp.description,
        COUNT(cm.user_id)::int AS member_count,
        owner_u.id   AS owner_id,
        owner_u.display_name AS owner_display_name,
        owner_u.email        AS owner_email
      FROM conversations c
      JOIN group_profiles gp
        ON gp.conversation_id = c.id
      LEFT JOIN conversation_members cm
        ON cm.conversation_id = c.id
      LEFT JOIN LATERAL (
        SELECT u.id, u.display_name, u.email
        FROM conversation_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.conversation_id = c.id
          AND m.role = 'owner'
        LIMIT 1
      ) AS owner_u ON TRUE
      WHERE c.id = $1 AND c.type = 'group'
      GROUP BY
        c.id,
        c.created_at,
        c.status,
        gp.name,
        gp.description,
        owner_u.id,
        owner_u.display_name,
        owner_u.email
    `;
      const detailRes = await client.query(detailSql, [id]);

      await client.query('COMMIT');
      client.release();

      if (!detailRes.rowCount) {
        return res.status(404).json({
          message: 'Không tìm thấy nhóm sau khi cập nhật',
        });
      }

      return res.json({ group: detailRes.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      console.error('/api/admin/groups/:id/status error:', err);
      return res.status(500).json({ message: 'Lỗi server' });
    }
  },
);

router.get(
  '/groups/:id/members',
  authRequired,
  adminOnly,
  async (req, res) => {
    try {
      const { id } = req.params;

      const sql = `
      SELECT
        cm.user_id      AS id,
        cm.role         AS role,
        cm.is_muted     AS is_muted,
        cm.joined_at    AS joined_at,
        u.display_name  AS display_name,
        u.email         AS email,
        u.status        AS status,
        u.is_email_verified,
        a.url           AS avatar_url
      FROM conversation_members cm
      JOIN conversations c ON c.id = cm.conversation_id
      JOIN users u ON u.id = cm.user_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE cm.conversation_id = $1
        AND c.type = 'group'
      ORDER BY
        (cm.role = 'owner') DESC,
        (cm.role = 'admin') DESC,
        LOWER(u.display_name)
    `;

      const r = await pool.query(sql, [id]);

      if (r.rowCount === 0) {
        const check = await pool.query(
          `SELECT 1 FROM conversations WHERE id = $1 AND type = 'group'`,
          [id],
        );
        if (!check.rowCount) {
          return res.status(404).json({ message: 'Không tìm thấy nhóm' });
        }
      }

      const members = r.rows.map(row => ({
        id: row.id,
        display_name: row.display_name,
        email: row.email,
        status: row.status,
        role: row.role,
        is_muted: row.is_muted,
        joined_at: row.joined_at,
        is_email_verified: row.is_email_verified,
        avatar_url: row.avatar_url,
      }));

      return res.json({ members });
    } catch (err) {
      console.error('/api/admin/groups/:id/members error:', err);
      return res.status(500).json({ message: 'Lỗi server' });
    }
  },
);

// GET /api/admin/stats  -> số liệu tổng quan + danh sách mới nhất
router.get('/stats', authRequired, adminOnly, async (req, res) => {
  try {
    // Đếm users (loại admin)
    const totalUsersQ = `
      SELECT COUNT(*)::int AS c
      FROM users u
      WHERE u.id NOT IN (SELECT user_id FROM admins)
    `;
    const activeUsersQ = `
      SELECT COUNT(*)::int AS c
      FROM users u
      WHERE u.status='active'
        AND u.id NOT IN (SELECT user_id FROM admins)
    `;
    const lockedUsersQ = `
      SELECT COUNT(*)::int AS c
      FROM users u
      WHERE u.status='locked'
        AND u.id NOT IN (SELECT user_id FROM admins)
    `;
    const bannedUsersQ = `
      SELECT COUNT(*)::int AS c
      FROM users u
      WHERE u.status='banned'
        AND u.id NOT IN (SELECT user_id FROM admins)
    `;

    // Đếm group đang active
    const activeGroupsQ = `
      SELECT COUNT(*)::int AS c
      FROM conversations c
      WHERE c.type='group' AND c.status='active'
    `;

    // New users 7 ngày & messages 24h
    const newUsers7dQ = `
      SELECT COUNT(*)::int AS c
      FROM users u
      WHERE u.created_at >= now() - interval '7 days'
        AND u.id NOT IN (SELECT user_id FROM admins)
    `;
    const messages24hQ = `
      SELECT COUNT(*)::int AS c
      FROM messages m
      WHERE m.created_at >= now() - interval '24 hours'
    `;

    // Danh sách mới nhất
    const recentUsersQ = `
      SELECT
        u.id, u.email, u.display_name, u.username, u.created_at,
        a.url AS avatar_url
      FROM users u
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE u.id NOT IN (SELECT user_id FROM admins)
      ORDER BY u.created_at DESC
      LIMIT 6
    `;
    const recentGroupsQ = `
      SELECT
        c.id, gp.name, c.created_at, c.status,
        a.url AS avatar_url,
        COALESCE(gp.description,'') AS description
      FROM conversations c
      JOIN group_profiles gp ON gp.conversation_id = c.id
      LEFT JOIN assets a
        ON a.id = COALESCE(gp.avatar_asset_id, c.avatar_asset_id)
      WHERE c.type='group'
      ORDER BY c.created_at DESC
      LIMIT 6
    `;

    const [
      totalUsers, activeUsers, lockedUsers, bannedUsers,
      activeGroups, newUsers7d, messages24h,
      recentUsers, recentGroups
    ] = await Promise.all([
      pool.query(totalUsersQ),
      pool.query(activeUsersQ),
      pool.query(lockedUsersQ),
      pool.query(bannedUsersQ),
      pool.query(activeGroupsQ),
      pool.query(newUsers7dQ),
      pool.query(messages24hQ),
      pool.query(recentUsersQ),
      pool.query(recentGroupsQ),
    ]);

    return res.json({
      totals: {
        users: totalUsers.rows[0].c,
        activeUsers: activeUsers.rows[0].c,
        lockedUsers: lockedUsers.rows[0].c,
        bannedUsers: bannedUsers.rows[0].c,
        activeGroups: activeGroups.rows[0].c,
        newUsers7d: newUsers7d.rows[0].c,
        messages24h: messages24h.rows[0].c,
      },
      recentUsers: recentUsers.rows,
      recentGroups: recentGroups.rows,
    });
  } catch (err) {
    console.error('/api/admin/stats error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

export default router;