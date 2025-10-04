import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { load } from "https://deno.land/std@0.192.0/dotenv/mod.ts";
import {
  initDb,
  submitEntry,
  getRecentApproved,
  getPendingSubmissions,
  reviewSubmission,
  getAcfunUrl,
  closeDb,
  verifyAdmin,
  addSecondaryAdmin,
  getAdmins,
} from "./db.ts";

// 加载环境变量
await load({ export: true });

// 初始化数据库连接
await initDb();

// 从OMDb API获取电影海报
async function getPoster(imdbId: string) {
  const apiKey = Deno.env.get("OMDB_API_KEY");
  if (!apiKey) throw new Error("OMDB_API_KEY is not set in environment variables");

  try {
    const response = await fetch(
      `https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}`
    );
    
    if (!response.ok) {
      throw new Error(`OMDb API request failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.Poster && data.Poster !== "N/A" ? data.Poster : null;
  } catch (error) {
    console.error(`Error fetching poster for ${imdbId}:`, error);
    return null;
  }
}

// 管理员身份验证（基于Cookie）
async function authenticateAdmin(req: Request): Promise<{
  valid: boolean;
  username?: string;
  role?: 'super' | 'secondary';
}> {
  // 从cookie获取登录状态
  const cookie = req.headers.get("Cookie") || "";
  const adminMatch = cookie.match(/admin=([^;]+)/);
  if (!adminMatch) return { valid: false };

  const username = adminMatch[1];
  // 验证用户是否存在
  const result = await client.queryObject({
    text: "SELECT username, role FROM admins WHERE username = $1",
    args: [username],
  });

  if (result.rows.length === 0) {
    return { valid: false };
  }

  return {
    valid: true,
    username: result.rows[0].username,
    role: result.rows[0].role as 'super' | 'secondary'
  };
}

// 处理所有HTTP请求
async function handleRequest(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname;

  // 静态资源路由
  if (path.startsWith("/static/")) {
    try {
      const file = await Deno.readFile(`.${path}`);
      const contentType = path.endsWith(".js") 
        ? "application/javascript" 
        : "text/css";
      return new Response(file, {
        headers: { "Content-Type": contentType },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // 提交新条目的页面
  if (path === "/submit") {
    // 处理表单提交
    if (req.method === "POST") {
      try {
        const formData = await req.formData();
        const imdbId = formData.get("imdb_id")?.toString().trim();
        const acfunUrl = formData.get("acfun_url")?.toString().trim();

        if (!imdbId || !acfunUrl) {
          return new Response("IMDb ID and AcFun URL are required", { status: 400 });
        }

        await submitEntry(imdbId, acfunUrl);
        return new Response(`
          <html>
            <body>
              <p>Submission successful! Redirecting...</p>
              <script>setTimeout(() => window.location.href = '/submit', 2000)</script>
            </body>
          </html>
        `, { headers: { "Content-Type": "text/html" } });
      } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 400 });
      }
    }

    // 显示提交表单
    return new Response(`
      <html>
        <head>
          <title>Submit Trailer</title>
          <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="container mx-auto p-4">
          <div class="mb-4">
            <a href="/admin/login" class="text-blue-600 hover:underline">
              Admin Login
            </a>
          </div>
          <h1 class="text-2xl font-bold mb-4">Submit New Trailer</h1>
          <form method="POST" class="space-y-4">
            <div>
              <label class="block">IMDb ID:</label>
              <input type="text" name="imdb_id" required 
                    class="border p-2 w-full" placeholder="e.g. tt1234567">
            </div>
            <div>
              <label class="block">AcFun URL:</label>
              <input type="url" name="acfun_url" required 
                    class="border p-2 w-full" placeholder="https://www.acfun.cn/...">
            </div>
            <button type="submit" class="bg-blue-500 text-white p-2 rounded">Submit</button>
          </form>
        </body>
      </html>
    `, { headers: { "Content-Type": "text/html" } });
  }

  // 管理员登录页面
  if (path === "/admin/login") {
    if (req.method === "POST") {
      const formData = await req.formData();
      const username = formData.get("username")?.toString();
      const password = formData.get("password")?.toString();

      if (!username || !password) {
        return new Response("Username and password are required", { status: 400 });
      }

      const result = await verifyAdmin(username, password);
      if (result.valid) {
        // 设置登录Cookie
        const headers = new Headers({
          "Location": "/admin",
          "Set-Cookie": `admin=${username}; HttpOnly; Path=/admin; Max-Age=86400`
        });
        return new Response(null, { status: 302, headers });
      } else {
        return new Response(`
          <html>
            <body>
              <p>Invalid credentials</p>
              <a href="/admin/login">Try again</a>
            </body>
          </html>
        `, { headers: { "Content-Type": "text/html" } });
      }
    }

    // 显示登录表单
    return new Response(`
      <html>
        <head>
          <title>Admin Login</title>
          <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="container mx-auto p-4">
          <h1 class="text-2xl font-bold mb-4">Admin Login</h1>
          <form method="POST" class="space-y-4 w-64">
            <div>
              <label class="block">Username:</label>
              <input type="text" name="username" required class="border p-2 w-full">
            </div>
            <div>
              <label class="block">Password:</label>
              <input type="password" name="password" required class="border p-2 w-full">
            </div>
            <button type="submit" class="bg-blue-500 text-white p-2 rounded w-full">
              Login
            </button>
          </form>
        </body>
      </html>
    `, { headers: { "Content-Type": "text/html" } });
  }

  // API: 通过IMDb ID获取AcFun URL
  if (path.startsWith("/api/")) {
    const imdbId = path.split("/")[2];
    if (imdbId) {
      try {
        const acfunUrl = await getAcfunUrl(imdbId);
        return new Response(JSON.stringify({ 
          imdb_id: imdbId,
          acfun_url: acfunUrl 
        }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "Invalid IMDb ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 管理员API: 管理二级管理员（仅超级管理员）
  if (path === "/admin/api/admins") {
    const admin = await authenticateAdmin(req);
    if (!admin.valid) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 只有超级管理员可以管理管理员
    if (admin.role !== "super") {
      return new Response("Forbidden: Requires super admin privileges", { status: 403 });
    }

    // 获取管理员列表
    if (req.method === "GET") {
      try {
        const admins = await getAdmins();
        return new Response(JSON.stringify(admins), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
    }

    // 添加二级管理员
    if (req.method === "POST") {
      try {
        const { username, password } = await req.json();
        if (!username || !password) {
          return new Response(JSON.stringify({ error: "Username and password are required" }), {
            status: 400,
          });
        }
        
        await addSecondaryAdmin(admin.username!, username, password);
        return new Response(JSON.stringify({ 
          success: true, 
          message: `Secondary admin ${username} created` 
        }), { status: 201 });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400 });
      }
    }

    return new Response("Method not allowed", { status: 405 });
  }

  // 管理员页面
  if (path === "/admin") {
    const admin = await authenticateAdmin(req);
    if (!admin.valid) {
      // 未登录则重定向到登录页
      const headers = new Headers({ "Location": "/admin/login" });
      return new Response(null, { status: 302, headers });
    }

    // 处理审核操作
    if (req.method === "POST") {
      try {
        const formData = await req.formData();
        const id = formData.get("id") as string;
        const action = formData.get("action") as string;
        const confirmed = formData.get("confirmed") as string;

        // 验证是否已确认
        if (confirmed !== "true") {
          return new Response("Operation requires confirmation", { status: 400 });
        }

        if (!id || !action || !["approve", "reject"].includes(action)) {
          return new Response("Invalid request data", { status: 400 });
        }

        await reviewSubmission(id, action === "approve", admin.username!);
        return new Response(null, { 
          status: 303, 
          headers: { Location: "/admin" } 
        });
      } catch (error) {
        return new Response(`Error processing review: ${error.message}`, { status: 500 });
      }
    }

    // 显示管理员页面
    try {
      const submissions = await getPendingSubmissions();
      
      const html = `
        <html>
          <head>
            <title>Admin Panel - Movie Trailers</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css" rel="stylesheet">
          </head>
          <body class="bg-gray-50">
            <header class="bg-gray-800 text-white p-4">
              <div class="container mx-auto">
                <h1 class="text-2xl font-bold">
                  <i class="fa fa-tachometer mr-2"></i>Admin Panel
                </h1>
                <p class="text-gray-300">Logged in as: ${admin.username} (${admin.role})</p>
              </div>
            </header>

            <main class="container mx-auto p-4">
              <section class="mb-8">
                <h2 class="text-xl font-semibold mb-4 flex items-center">
                  <i class="fa fa-list-alt mr-2"></i>Pending Submissions (${submissions.length})
                </h2>
                
                ${submissions.length === 0 ? `
                  <div class="bg-green-100 p-4 rounded">
                    <i class="fa fa-check-circle text-green-600 mr-2"></i>
                    No pending submissions to review
                  </div>
                ` : `
                  <table class="min-w-full bg-white border rounded-lg overflow-hidden">
                    <thead class="bg-gray-100">
                      <tr>
                        <th class="py-2 px-4 border-b">IMDb ID</th>
                        <th class="py-2 px-4 border-b">AcFun URL</th>
                        <th class="py-2 px-4 border-b">Submitted At</th>
                        <th class="py-2 px-4 border-b">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${submissions.map(sub => `
                        <tr class="hover:bg-gray-50">
                          <td class="py-2 px-4 border-b">${sub.imdb_id}</td>
                          <td class="py-2 px-4 border-b">
                            <a href="${sub.acfun_url}" target="_blank" class="text-blue-600 hover:underline">
                              <i class="fa fa-external-link mr-1"></i>View
                            </a>
                          </td>
                          <td class="py-2 px-4 border-b">
                            ${new Date(sub.submitted_at).toLocaleString()}
                          </td>
                          <td class="py-2 px-4 border-b">
                            <div class="inline-flex gap-2">
                              <button 
                                onclick="confirmAction(${sub.id}, 'approve')"
                                class="bg-green-100 text-green-800 px-3 py-1 rounded hover:bg-green-200"
                              >
                                <i class="fa fa-check mr-1"></i>Approve
                              </button>
                              <button 
                                onclick="confirmAction(${sub.id}, 'reject')"
                                class="bg-red-100 text-red-800 px-3 py-1 rounded hover:bg-red-200"
                              >
                                <i class="fa fa-times mr-1"></i>Reject
                              </button>
                            </div>
                            <!-- 隐藏的确认表单 -->
                            <form id="form-${sub.id}" method="POST" class="hidden">
                              <input type="hidden" name="id" value="${sub.id}">
                              <input type="hidden" name="action" value="">
                              <input type="hidden" name="confirmed" value="true">
                            </form>
                          </td>
                        </tr>
                      `).join("")}
                    </tbody>
                  </table>
                `}
              </section>

              ${admin.role === "super" ? `
                <section class="border-t pt-6">
                  <h2 class="text-xl font-semibold mb-4 flex items-center">
                    <i class="fa fa-users mr-2"></i>Manage Administrators
                  </h2>
                  
                  <div id="adminMessage" class="mt-2 hidden"></div>
                  
                  <div class="bg-white p-4 rounded-lg mb-6">
                    <h3 class="font-medium mb-3">Add Secondary Admin</h3>
                    <form id="addAdminForm" class="space-y-3">
                      <div>
                        <label class="block text-sm">Username</label>
                        <input type="text" name="username" required 
                              class="border p-2 w-full md:w-1/3">
                      </div>
                      <div>
                        <label class="block text-sm">Password</label>
                        <input type="password" name="password" required 
                              class="border p-2 w-full md:w-1/3">
                      </div>
                      <button type="submit" class="bg-blue-500 text-white px-4 py-2 rounded">
                        <i class="fa fa-plus mr-1"></i>Add Admin
                      </button>
                    </form>
                  </div>
                  
                  <div class="bg-white rounded-lg overflow-hidden">
                    <h3 class="font-medium p-4 border-b">Existing Admins</h3>
                    <table class="min-w-full">
                      <thead class="bg-gray-100">
                        <tr>
                          <th class="py-2 px-4 border-b text-left">Username</th>
                          <th class="py-2 px-4 border-b text-left">Role</th>
                          <th class="py-2 px-4 border-b text-left">Created At</th>
                        </tr>
                      </thead>
                      <tbody id="adminList">
                        <!-- Admin list will be loaded via JavaScript -->
                      </tbody>
                    </table>
                  </div>
                </section>
              ` : ""}
            </main>

            <script src="/static/admin.js"></script>
            <script>
              // 确认审核操作
              function confirmAction(id, action) {
                const confirmed = confirm(`Are you sure you want to ${action} this submission?`);
                if (confirmed) {
                  const form = document.getElementById(\`form-\${id}\`);
                  if (form) {
                    form.querySelector('input[name="action"]').value = action;
                    form.submit();
                  }
                }
              }
            </script>
          </body>
        </html>
      `;
      
      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    } catch (error) {
      return new Response(`Error loading admin panel: ${error.message}`, { status: 500 });
    }
  }

  // 首页 - 显示最近通过的条目
  try {
    const recent = await getRecentApproved(20);
    const html = `
      <html>
        <head>
          <title>Movie Trailers</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <link href="https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css" rel="stylesheet">
        </head>
        <body class="bg-gray-50">
          <header class="bg-gray-800 text-white p-4">
            <div class="container mx-auto">
              <h1 class="text-2xl font-bold">
                <i class="fa fa-film mr-2"></i>Movie Trailers Archive
              </h1>
              <div class="mt-2">
                <a href="/submit" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded inline-block">
                  <i class="fa fa-plus mr-1"></i>Submit New Trailer
                </a>
                <a href="/admin/login" class="ml-2 bg-gray-600 hover:bg-gray-700 text-white px-3 py-1 rounded inline-block">
                  <i class="fa fa-lock mr-1"></i>Admin Login
                </a>
              </div>
            </div>
          </header>

          <main class="container mx-auto p-4">
            <h2 class="text-xl font-semibold mb-4">Recently Approved Trailers</h2>
            
            ${recent.length === 0 ? `
              <div class="bg-yellow-100 p-4 rounded">
                <i class="fa fa-info-circle text-yellow-600 mr-2"></i>
                No approved trailers yet
              </div>
            ` : `
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                ${await Promise.all(recent.map(async (item) => {
                  const poster = await getPoster(item.imdb_id);
                  return `
                    <div class="bg-white rounded-lg overflow-hidden shadow hover:shadow-md transition-shadow">
                      ${poster ? `
                        <div class="h-48 bg-gray-200 flex items-center justify-center">
                          <img src="${poster}" alt="Poster for ${item.imdb_id}" 
                               class="h-full object-cover">
                        </div>
                      ` : `
                        <div class="h-48 bg-gray-200 flex items-center justify-center">
                          <i class="fa fa-film text-5xl text-gray-400"></i>
                        </div>
                      `}
                      <div class="p-4">
                        <div class="font-medium mb-2">IMDb ID: ${item.imdb_id}</div>
                        <a href="${item.acfun_url}" target="_blank" 
                           class="text-blue-600 hover:underline mb-2 inline-block">
                          <i class="fa fa-external-link mr-1"></i>View on AcFun
                        </a>
                        <div class="text-sm text-gray-500">
                          Approved: ${new Date(item.approved_at).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  `;
                }))}
              </div>
            `}
          </main>
        </body>
      </html>
    `;
    
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  } catch (error) {
    return new Response(`Error loading page: ${error.message}`, { status: 500 });
  }
}

// 启动服务器
serve(handleRequest);

// 优雅关闭
Deno.addSignalListener("SIGINT", async () => {
  console.log("Closing database connection...");
  await closeDb();
  Deno.exit(0);
});

Deno.addSignalListener("SIGTERM", async () => {
  console.log("Closing database connection...");
  await closeDb();
  Deno.exit(0);
});
