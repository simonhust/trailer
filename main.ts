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

// 管理员身份验证
async function authenticateAdmin(req: Request): Promise<{
  valid: boolean;
  username?: string;
  role?: 'super' | 'secondary';
}> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return { valid: false };

  const [scheme, encoded] = authHeader.split(" ");
  if (scheme !== "Basic" || !encoded) return { valid: false };

  try {
    const decoded = new TextDecoder().decode(atob(encoded));
    const [username, password] = decoded.split(":");
    
    if (!username || !password) return { valid: false };
    
    return await verifyAdmin(username, password);
  } catch (error) {
    console.error("Admin authentication error:", error);
    return { valid: false };
  }
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

  // 首页路由
  if (path === "/") {
    // 处理提交表单的POST请求
    if (req.method === "POST") {
      try {
        const formData = await req.formData();
        const imdbId = formData.get("imdbId") as string;
        const acfunUrl = formData.get("acfunUrl") as string;

        if (!imdbId || !acfunUrl) {
          return new Response(JSON.stringify({ error: "IMDb ID and AcFun URL are required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        await submitEntry(imdbId, acfunUrl);
        return new Response(JSON.stringify({ success: true, message: "Submission received. Waiting for review." }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 显示首页HTML
    const html = `
      <html>
        <head>
          <title>Movie Trailer Link Manager</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <link href="https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css" rel="stylesheet">
        </head>
        <body class="bg-gray-100 min-h-screen">
          <header class="bg-gray-800 text-white p-6">
            <div class="container mx-auto">
              <h1 class="text-3xl font-bold">
                <i class="fa fa-film mr-3"></i>Movie Trailer Link Manager
              </h1>
              <p class="mt-2 text-gray-300">Submit and find AcFun trailer links by IMDb ID</p>
            </div>
          </header>

          <main class="container mx-auto p-6">
            <section class="bg-white rounded-lg shadow-md p-6 mb-8">
              <h2 class="text-2xl font-semibold mb-4">
                <i class="fa fa-paper-plane mr-2"></i>Submit New Trailer Link
              </h2>
              
              <form id="submissionForm" class="space-y-4">
                <div>
                  <label for="imdbId" class="block text-gray-700 mb-1">IMDb ID</label>
                  <input 
                    type="text" 
                    id="imdbId" 
                    name="imdbId" 
                    placeholder="e.g., tt1234567" 
                    pattern="^tt\d+$"
                    title="IMDb ID must start with 'tt' followed by numbers"
                    required
                    class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                </div>
                
                <div>
                  <label for="acfunUrl" class="block text-gray-700 mb-1">AcFun Trailer URL</label>
                  <input 
                    type="url" 
                    id="acfunUrl" 
                    name="acfunUrl" 
                    placeholder="https://www.acfun.cn/..." 
                    required
                    class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                </div>
                
                <button 
                  type="submit" 
                  class="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors flex items-center"
                >
                  <i class="fa fa-check mr-2"></i>Submit for Review
                </button>
              </form>
              
              <div id="message" class="mt-4 hidden p-3 rounded"></div>
            </section>

            <section class="bg-white rounded-lg shadow-md p-6">
              <h2 class="text-2xl font-semibold mb-4">
                <i class="fa fa-key mr-2"></i>Admin Access
              </h2>
              <p class="mb-4">Are you an administrator? Access the admin panel to review submissions.</p>
              <a 
                href="/admin" 
                class="inline-flex items-center bg-gray-800 text-white px-6 py-2 rounded-lg hover:bg-gray-700 transition-colors"
              >
                <i class="fa fa-lock mr-2"></i>Admin Panel
              </a>
            </section>
          </main>

          <footer class="bg-gray-800 text-white p-6 mt-12">
            <div class="container mx-auto text-center">
              <p>&copy; 2025 Movie Trailer Link Manager</p>
            </div>
          </footer>

          <script>
            // 处理表单提交
            document.getElementById('submissionForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              const messageEl = document.getElementById('message');
              const formData = new FormData(e.target);
              
              try {
                const response = await fetch('/', {
                  method: 'POST',
                  body: formData
                });
                
                const data = await response.json();
                
                if (response.ok) {
                  messageEl.textContent = data.message;
                  messageEl.className = 'mt-4 p-3 rounded bg-green-100 text-green-800';
                  e.target.reset();
                } else {
                  messageEl.textContent = data.error;
                  messageEl.className = 'mt-4 p-3 rounded bg-red-100 text-red-800';
                }
              } catch (error) {
                messageEl.textContent = 'An error occurred while submitting. Please try again.';
                messageEl.className = 'mt-4 p-3 rounded bg-red-100 text-red-800';
              }
              
              // 5秒后隐藏消息
              setTimeout(() => {
                messageEl.className = 'mt-4 hidden p-3 rounded';
              }, 5000);
            });
          </script>
        </body>
      </html>
    `;
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
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
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Admin Area"' },
      });
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
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Admin Area"' },
      });
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
                  
                  <div class="bg-white p-4 rounded-lg shadow">
                    <h3 class="font-medium mb-3">Current Administrators</h3>
                    <table class="min-w-full">
                      <thead class="bg-gray-50">
                        <tr>
                          <th class="py-2 px-4 border-b">Username</th>
                          <th class="py-2 px-4 border-b">Role</th>
                          <th class="py-2 px-4 border-b">Created At</th>
                        </tr>
                      </thead>
                      <tbody id="adminList">
                        <!-- 管理员列表将通过JS动态加载 -->
                      </tbody>
                    </table>

                    <div id="adminMessage" class="mt-2 hidden"></div>

                    <div class="mt-6 pt-4 border-t">
                      <h3 class="font-medium mb-3">Add Secondary Admin</h3>
                      <form id="addAdminForm" class="space-y-3">
                        <div>
                          <label class="block text-gray-700">Username</label>
                          <input type="text" name="username" class="px-3 py-2 border rounded" required>
                        </div>
                        <div>
                          <label class="block text-gray-700">Password</label>
                          <input type="password" name="password" class="px-3 py-2 border rounded" required>
                        </div>
                        <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                          Add Admin
                        </button>
                      </form>
                    </div>
                  </div>
                </section>
              ` : ""}
            </main>

            <script src="/static/admin.js"></script>
            <script>
              // 审核操作确认
              function confirmAction(id, action) {
                const confirmed = confirm(`Are you sure you want to ${action} this submission?`);
                if (confirmed) {
                  const form = document.getElementById(`form-${id}`);
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

  // 未匹配的路由
  return new Response("Not found", { status: 404 });
}

// 启动HTTP服务
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on http://localhost:${port}`);
await serve(handleRequest, { port });

// 关闭时清理数据库连接
window.addEventListener("unload", () => {
  closeDb();
});
