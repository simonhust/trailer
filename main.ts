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
                  
                  <div class="bg-white p-4 rounded-lg shadow mb-4">
                    <h3 class="font-medium mb-3">Add Secondary Admin</h3>
                    <form id="addAdminForm" class="flex flex-col sm:flex-row gap-2">
                      <input type="text" name="username" placeholder="Username" 
                        class="flex-1 px-3 py-2 border rounded">
                      <input type="password" name="password" placeholder="Password" 
                        class="flex-1 px-3 py-2 border rounded">
                      <button type="button" onclick="confirmAddAdmin()"
                        class="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
                        <i class="fa fa-plus mr-1"></i>Add Admin
                      </button>
                    </form>
                    <div id="adminMessage" class="mt-2 hidden"></div>
                  </div>
                  
                  <div class="bg-white p-4 rounded-lg shadow">
                    <h3 class="font-medium mb-3">Current Administrators</h3>
                    <table class="min-w-full">
                      <thead class="bg-gray-100">
                        <tr>
                          <th class="py-2 px-4 border-b">Username</th>
                          <th class="py-2 px-4 border-b">Role</th>
                          <th class="py-2 px-4 border-b">Created At</th>
                        </tr>
                      </thead>
                      <tbody id="adminList">
                        <!-- Will be populated by JavaScript -->
                      </tbody>
                    </table>
                  </div>
                </section>
              ` : ""}
            </main>

            <script>
              // 审核操作二次确认
              function confirmAction(id, action) {
                const actionText = action === 'approve' ? 'approve' : 'reject';
                const confirmation = confirm(`Are you sure you want to ${actionText} this submission?`);
                
                if (confirmation) {
                  const form = document.getElementById(`form-${id}`);
                  if (form) {
                    form.querySelector('input[name="action"]').value = action;
                    form.submit();
                  }
                }
              }

              // 添加管理员二次确认
              function confirmAddAdmin() {
                const username = document.querySelector('#addAdminForm input[name="username"]').value.trim();
                if (!username) {
                  showAdminMessage('Please enter a username', 'error');
                  return;
                }
                
                const confirmation = confirm(`Are you sure you want to add "${username}" as a secondary admin?`);
                if (confirmation) {
                  document.getElementById('addAdminForm').submit();
                }
              }
            </script>
            <script src="/static/admin.js"></script>
          </body>
        </html>
      `;

      return new Response(html, { headers: { "Content-Type": "text/html" } });
    } catch (error) {
      return new Response(`Error loading admin page: ${error.message}`, { status: 500 });
    }
  }

  // 处理提交新条目
  if (path === "/submit" && req.method === "POST") {
    try {
      const formData = await req.formData();
      const imdbId = (formData.get("imdb_id") as string)?.trim();
      const acfunUrl = (formData.get("acfun_url") as string)?.trim();

      if (!imdbId || !acfunUrl) {
        return new Response("IMDb ID and AcFun URL are required", { status: 400 });
      }

      if (!acfunUrl.startsWith("https://")) {
        return new Response("AcFun URL must start with https://", { status: 400 });
      }

      await submitEntry(imdbId, acfunUrl);
      return new Response(null, {
        status: 303,
        headers: { Location: "/" },
      });
    } catch (error) {
      if (error.message.includes("limit reached")) {
        return new Response(error.message, { 
          status: 429,
          headers: { "Content-Type": "text/plain" }
        });
      }
      return new Response(`Error submitting entry: ${error.message}`, { status: 500 });
    }
  }

  // 首页
  try {
    const recent = await getRecentApproved(10);
    const posters = await Promise.all(
      recent.map(async (item) => ({
        ...item,
        poster: await getPoster(item.imdb_id),
      }))
    );

    const html = `
      <html>
        <head>
          <title>Movie Trailers | Free Film & Music Clips</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <link href="https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css" rel="stylesheet">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body class="bg-gray-50">
          <header class="bg-white shadow-sm">
            <div class="container mx-auto p-4">
              <div class="flex justify-between items-center">
                <h1 class="text-2xl font-bold text-gray-800">
                  <i class="fa fa-film mr-2 text-blue-600"></i>Movie Trailers
                </h1>
                <a href="/admin" class="text-gray-600 hover:text-gray-900 flex items-center">
                  <i class="fa fa-lock mr-1"></i> Admin
                </a>
              </div>
            </div>
          </header>

          <main class="container mx-auto p-4">
            <section class="mb-8 bg-white p-6 rounded-lg shadow-sm">
              <h2 class="text-xl font-semibold mb-4">Submit New Trailer</h2>
              <form action="/submit" method="POST" onsubmit="return confirmSubmit()" class="space-y-4">
                <div>
                  <label for="imdb_id" class="block text-gray-700 mb-1">IMDb ID</label>
                  <input 
                    type="text" 
                    id="imdb_id" 
                    name="imdb_id" 
                    placeholder="e.g. tt1234567" 
                    class="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  >
                  <p class="text-sm text-gray-500 mt-1">
                    Find this on IMDb - looks like "tt" followed by 7-8 numbers
                  </p>
                </div>
                
                <div>
                  <label for="acfun_url" class="block text-gray-700 mb-1">AcFun URL</label>
                  <input 
                    type="url" 
                    id="acfun_url" 
                    name="acfun_url" 
                    placeholder="https://www.acfun.cn/..." 
                    class="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  >
                </div>
                
                <button 
                  type="submit" 
                  class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  <i class="fa fa-paper-plane mr-1"></i> Submit
                </button>
              </form>
            </section>

            <section>
              <h2 class="text-xl font-semibold mb-4">Recently Approved Trailers</h2>
              
              ${posters.length === 0 ? `
                <div class="bg-gray-100 p-6 rounded-lg text-center">
                  <i class="fa fa-info-circle text-2xl text-gray-500 mb-2"></i>
                  <p>No approved trailers yet. Check back soon!</p>
                </div>
              ` : `
                <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                  ${posters.map(item => item.poster ? `
                    <div class="bg-white rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                      <div class="relative pb-[150%]">
                        <img 
                          src="${item.poster}" 
                          alt="Poster for ${item.imdb_id}" 
                          class="absolute inset-0 w-full h-full object-cover"
                        >
                      </div>
                      <div class="p-3">
                        <p class="text-sm font-medium text-gray-800 mb-1">${item.imdb_id}</p>
                        <a 
                          href="${item.acfun_url}" 
                          target="_blank" 
                          class="text-blue-600 text-sm hover:underline flex items-center"
                        >
                          <i class="fa fa-play-circle mr-1"></i> Watch on AcFun
                        </a>
                        <p class="text-xs text-gray-500 mt-2">
                          Approved by ${item.reviewer}
                        </p>
                      </div>
                    </div>
                  ` : '').join("")}
                </div>
              `}
            </section>
          </main>

          <footer class="bg-gray-800 text-white mt-8 py-6">
            <div class="container mx-auto px-4 text-center text-sm">
              <p>© ${new Date().getFullYear()} Movie Trailers. All submitted content is reviewed.</p>
            </div>
          </footer>

          <script>
            // 提交内容二次确认
            function confirmSubmit() {
              const imdbId = document.getElementById('imdb_id').value.trim();
              const message = imdbId 
                ? `Are you sure you want to submit the trailer for ${imdbId}?`
                : 'Are you sure you want to submit this trailer?';
              
              return confirm(message);
            }
          </script>
        </body>
      </html>
    `;

    return new Response(html, { headers: { "Content-Type": "text/html" } });
  } catch (error) {
    return new Response(`Error loading page: ${error.message}`, { status: 500 });
  }
}

// 启动服务器
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on http://localhost:${port}`);
serve(handleRequest, { port });

// 优雅关闭
window.addEventListener("unload", async () => {
  console.log("Closing database connection...");
  await closeDb();
});
    