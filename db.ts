import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { crypto } from "https://deno.land/std@0.192.0/crypto/mod.ts";

// 数据库客户端实例
export let client: Client;
// 心跳定时器ID
let heartbeatInterval: number | undefined;

/**
 * 使用SHA-256进行密码哈希
 */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * 验证密码
 */
async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const newHash = await hashPassword(password);
  return newHash === hash;
}

/**
 * 初始化数据库连接并创建必要的表结构
 */
export async function initDb() {
  // 从环境变量获取数据库配置
  const hostname = Deno.env.get("CRATEDB_HOST") || "localhost:5432";
  const username = Deno.env.get("CRATEDB_USERNAME") || "crate";
  const password = Deno.env.get("CRATEDB_PASSWORD") || "";

  // 解析主机名和端口
  const [host, portStr] = hostname.split(":");
  const port = portStr ? parseInt(portStr) : 5432;

  // 创建数据库客户端
  client = new Client({
    user: username,
    password,
    hostname: host,
    port,
    database: "crate",
    ssl: hostname.includes(".cratedb.net"),
  });

  // 连接数据库
  try {
    await client.connect();
    console.log("Successfully connected to CrateDB");
  } catch (error) {
    console.error("Failed to connect to CrateDB:", error);
    throw error;
  }

  // 创建提交记录表 - 使用BIGINT类型确保能容纳大数字时间戳[4,8](@ref)
  await client.queryObject(`
    CREATE TABLE IF NOT EXISTS submissions (
      id BIGINT PRIMARY KEY,
      imdb_id TEXT NOT NULL,
      acfun_url TEXT NOT NULL,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'pending'
    )
  `);

  // 创建已通过审核的影片表
  await client.queryObject(`
    CREATE TABLE IF NOT EXISTS trailers (
      imdb_id TEXT PRIMARY KEY,
      acfun_url TEXT NOT NULL,
      approved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewer TEXT NOT NULL
    )
  `);

  // 创建管理员表
  await client.queryObject(`
    CREATE TABLE IF NOT EXISTS admins (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 创建系统表用于心跳检测
  await client.queryObject(`
    CREATE TABLE IF NOT EXISTS system_heartbeat (
      id INTEGER PRIMARY KEY,
      last_heartbeat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 初始化心跳记录 - 使用ON CONFLICT避免重复键错误
  try {
    await client.queryObject(`
      INSERT INTO system_heartbeat (id, last_heartbeat) 
      VALUES (1, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET last_heartbeat = CURRENT_TIMESTAMP
    `);
    console.log("Heartbeat table initialized or updated");
  } catch (error) {
    console.warn("Heartbeat table initialization note:", error.message);
  }

  // 初始化超级管理员（如果不存在）
  const superAdmin = Deno.env.get("ADMIN_USERNAME");
  const superPwd = Deno.env.get("ADMIN_PASSWORD");
  
  if (superAdmin && superPwd) {
    const hasAdmin = await client.queryObject({
      text: "SELECT 1 FROM admins WHERE username = $1",
      args: [superAdmin],
    });
    
    if (hasAdmin.rows.length === 0) {
      const hash = await hashPassword(superPwd);
      await client.queryObject({
        text: "INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, 'super')",
        args: [superAdmin, hash],
      });
      console.log(`Super admin "${superAdmin}" created`);
    } else {
      console.log(`Super admin "${superAdmin}" already exists`);
    }
  } else {
    console.warn("ADMIN_USERNAME and ADMIN_PASSWORD not set - no initial admin created");
  }

  // 启动心跳机制
  startHeartbeat();
}

/**
 * 数据库心跳函数 - 更新最后活动时间
 */
async function heartbeat() {
  if (!client) {
    console.error("Database client not initialized, cannot send heartbeat");
    return;
  }

  try {
    await client.queryObject(`
      UPDATE system_heartbeat 
      SET last_heartbeat = CURRENT_TIMESTAMP 
      WHERE id = 1
    `);
    console.log(`Heartbeat sent at ${new Date().toISOString()}`);
  } catch (error) {
    console.error("Failed to send heartbeat:", error);
    // 尝试重新连接
    try {
      console.log("Attempting to reconnect to database...");
      await client.connect();
      console.log("Reconnected successfully");
    } catch (reconnectError) {
      console.error("Reconnection failed:", reconnectError);
    }
  }
}

/**
 * 启动心跳定时器（每12小时一次）
 */
function startHeartbeat() {
  // 立即发送一次心跳
  heartbeat();
  
  // 12小时 = 12 * 60 * 60 * 1000 毫秒
  const intervalMs = 12 * 60 * 60 * 1000;
  
  // 设置定时器
  heartbeatInterval = setInterval(heartbeat, intervalMs);
  console.log(`Heartbeat scheduler started (interval: ${intervalMs}ms)`);
}

/**
 * 获取待审核条目的数量
 */
export async function getPendingCount(): Promise<number> {
  const result = await client.queryObject({
    text: "SELECT COUNT(*) as count FROM submissions WHERE status = 'pending'",
    args: [],
  });
  return Number(result.rows[0].count);
}

/**
 * 提交新的条目 - 使用数字类型的ID（时间戳）[1,7](@ref)
 */
export async function submitEntry(imdbId: string, acfunUrl: string) {
  const pendingCount = await getPendingCount();
  
  // 限制未审核数据最多400条
  if (pendingCount >= 400) {
    throw new Error("Pending submissions limit reached (400). Try again later.");
  }
  
  // 使用数字类型的时间戳作为ID，避免字符串转换问题[4](@ref)
  const id = Date.now(); // 这是数字类型，不是字符串
  
  try {
    await client.queryObject({
      text: "INSERT INTO submissions (id, imdb_id, acfun_url) VALUES ($1, $2, $3)",
      args: [id, imdbId, acfunUrl], // id 是数字类型
    });
    
    console.log(`Submission created with numeric ID: ${id}`);
    return { success: true, id };
  } catch (error) {
    console.error("Submit entry error:", error);
    
    // 如果是主键冲突错误，可以尝试使用不同的ID
    if (error.message.includes("primary key") || error.message.includes("exists already")) {
      console.log("ID conflict detected, generating new ID...");
      const newId = Date.now() + Math.floor(Math.random() * 1000);
      try {
        await client.queryObject({
          text: "INSERT INTO submissions (id, imdb_id, acfun_url) VALUES ($1, $2, $3)",
          args: [newId, imdbId, acfunUrl],
        });
        console.log(`Submission created with new numeric ID: ${newId}`);
        return { success: true, id: newId };
      } catch (retryError) {
        throw new Error(`Retry failed: ${retryError.message}`);
      }
    }
    
    throw new Error(`Submission failed: ${error.message}`);
  }
}

/**
 * 验证管理员身份并返回角色
 */
export async function verifyAdmin(username: string, password: string): Promise<{
  valid: boolean;
  role?: 'super' | 'secondary';
  username?: string;
}> {
  const result = await client.queryObject({
    text: "SELECT username, password_hash, role FROM admins WHERE username = $1",
    args: [username],
  });
  
  if (result.rows.length === 0) {
    return { valid: false };
  }
  
  const row = result.rows[0];
  const valid = await verifyPassword(password, row.password_hash);
  
  return {
    valid,
    role: valid ? row.rows[0].role as 'super' | 'secondary' : undefined,
    username: valid ? row.username : undefined,
  };
}

/**
 * 超级管理员添加二级管理员
 */
export async function addSecondaryAdmin(
  superAdminUsername: string,
  newUsername: string,
  newPassword: string
) {
  // 验证操作人是超级管理员
  const superAdmin = await client.queryObject({
    text: "SELECT role FROM admins WHERE username = $1",
    args: [superAdminUsername],
  });
  
  if (superAdmin.rows.length === 0 || superAdmin.rows[0].role !== 'super') {
    throw new Error("Only super admins can add new administrators");
  }
  
  // 检查新用户名是否已存在
  const existing = await client.queryObject({
    text: "SELECT 1 FROM admins WHERE username = $1",
    args: [newUsername],
  });
  
  if (existing.rows.length > 0) {
    throw new Error(`Username "${newUsername}" already exists`);
  }
  
  // 加密密码并添加新管理员
  const hash = await hashPassword(newPassword);
  await client.queryObject({
    text: "INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, 'secondary')",
    args: [newUsername, hash],
  });
}

/**
 * 获取所有管理员列表
 */
export async function getAdmins() {
  const result = await client.queryObject({
    text: "SELECT username, role, created_at FROM admins ORDER BY created_at DESC",
    args: [],
  });
  return result.rows;
}

/**
 * 审核提交的条目
 */
export async function reviewSubmission(
  submissionId: string,
  approve: boolean,
  reviewer: string
) {
  // 获取待审核条目
  const submission = await client.queryObject({
    text: "SELECT imdb_id, acfun_url FROM submissions WHERE id = $1 AND status = 'pending'",
    args: [submissionId],
  });
  
  if (submission.rows.length === 0) {
    throw new Error("Submission not found or already reviewed");
  }
  
  const row = submission.rows[0];
  const imdb_id = row.imdb_id;
  const acfun_url = row.acfun_url;
  
  // 开启事务确保数据一致性
  try {
    await client.queryObject("BEGIN");
    
    // 更新提交状态
    await client.queryObject({
      text: "UPDATE submissions SET status = $1 WHERE id = $2",
      args: [approve ? 'approved' : 'rejected', submissionId],
    });
    
    // 如果通过，添加到trailers表（已存在则更新）
    if (approve) {
      await client.queryObject({
        text: `INSERT INTO trailers (imdb_id, acfun_url, reviewer) 
               VALUES ($1, $2, $3) 
               ON CONFLICT (imdb_id) DO UPDATE 
               SET acfun_url = $2, reviewer = $3, approved_at = CURRENT_TIMESTAMP`,
        args: [imdb_id, acfun_url, reviewer],
      });
    }
    
    await client.queryObject("COMMIT");
  } catch (error) {
    await client.queryObject("ROLLBACK");
    throw error;
  }
}

/**
 * 获取最近通过审核的条目
 */
export async function getRecentApproved(limit = 10) {
  const result = await client.queryObject({
    text: "SELECT imdb_id, acfun_url, approved_at, reviewer FROM trailers ORDER BY approved_at DESC LIMIT $1",
    args: [limit],
  });
  return result.rows;
}

/**
 * 获取所有待审核的条目
 */
export async function getPendingSubmissions() {
  const result = await client.queryObject({
    text: "SELECT id, imdb_id, acfun_url, submitted_at FROM submissions WHERE status = 'pending' ORDER BY submitted_at ASC",
    args: [],
  });
  return result.rows;
}

/**
 * 通过IMDb ID获取对应的AcFun URL
 */
export async function getAcfunUrl(imdbId: string) {
  const result = await client.queryObject({
    text: "SELECT acfun_url FROM trailers WHERE imdb_id = $1",
    args: [imdbId],
  });
  return result.rows.length > 0 ? result.rows[0].acfun_url : null;
}

/**
 * 关闭数据库连接和心跳定时器
 */
export async function closeDb() {
  // 清除心跳定时器
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    console.log("Heartbeat scheduler stopped");
  }
  
  if (client) {
    await client.end();
    console.log("Database connection closed");
  }
}
