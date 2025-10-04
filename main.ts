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
        : path.endsWith(".css") 
        ? "text/css" 
        : "application/octet-stream";
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
                              <form id="form-${sub.id}" method="POST" class="inline">
                                <input type="hidden" name="id" value="${sub.id}">
                                <input type="hidden" name="confirmed" value="true">
                                <button 
                                  type="submit"
                                  name="action"
                                  value="approve"
                                  class="bg-green-100 text-green-800 px-3 py-1 rounded hover:bg-green-200"
                                  onclick="return confirm('Are you sure you want to approve this submission?')"
                                >
                                  <i class="fa fa-check mr-1"></i>Approve
                                </button>
                                <button 
                                  type="submit"
                                  name="action"
                                  value="reject"
                                  class="bg-red-100 text-red-800 px-3 py-1 rounded hover:bg-red-200"
                                  onclick="return confirm('Are you sure you want to reject this submission?')"
                                >
                                  <i class="fa fa-times mr-1"></i>Reject
                                </button>
                              </form>
                            </div>
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
                    <i class="fa fa-users mr-2"></i>Admin Management
                  </h2>
                  
                  <div class="bg-white p-4 rounded-lg border mb-6">
                    <h3 class="font-medium mb-3">Add New Secondary Admin</h3>
                    <form action="/admin/api/admins" method="POST" class="space-y-4">
                      <div>
                        <label class="block text-sm font-medium text-gray-700">Username</label>
                        <input type="text" name="username" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                      </div>
                      <div>
                        <label class="block text-sm font-medium text-gray-700">Password</label>
                        <input type="password" name="password" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                      </div>
                      <button type="submit" class="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700">
                        <i class="fa fa-plus mr-2"></i>Add Admin
                      </button>
                    </form>
                  </div>
                  
                  <div class="bg-white rounded-lg border overflow-hidden">
                    <h3 class="font-medium p-4 border-b">Current Admins</h3>
                    <div id="adminList" class="p-4">
                      <!-- Admin list will be loaded via JavaScript -->
                      <p class="text-gray-500">Loading admin list...</p>
                    </div>
                  </div>
                </section>
              ` : ""}
            </main>

            <script>
              // 加载管理员列表
              async function loadAdmins() {
                try {
                  const response = await fetch('/admin/api/admins');
                  if (response.ok) {
                    const admins = await response.json();
                    const adminList = document.getElementById('adminList');
                    if (admins.length > 0) {
                      adminList.innerHTML = \`
                        <table class="min-w-full">
                          <thead class="bg-gray-100">
                            <tr>
                              <th class="py-2 px-4 border-b">Username</th>
                              <th class="py-2 px-4 border-b">Role</th>
                              <th class="py-2 px-4 border-b">Created At</th>
                            </tr>
                          </thead>
                          <tbody>
                            \${admins.map(admin => \`
                              <tr>
                                <td class="py-2 px-4 border-b">\${admin.username}</td>
                                <td class="py-2 px-4 border-b">\${admin.role}</td>
                                <td class="py-2 px-4 border-b">\${new Date(admin.created_at).toLocaleString()}</td>
                              </tr>
                            \`).join('')}
                          </tbody>
                        </table>
                      \`;
                    } else {
                      adminList.innerHTML = '<p class="text-gray-500">No admins found.</p>';
                    }
                  }
                } catch (error) {
                  console.error('Error loading admins:', error);
                }
              }

              // 如果是超级管理员，加载管理员列表
              if (${admin.role === "super"}) {
                loadAdmins();
              }
            </script>
          </body>
        </html>
      `;
      
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return new Response(`Error loading admin page: ${error.message}`, { status: 500 });
    }
  }

  // 首页
  if (path === "/" || path === "") {
    try {
      const recent = await getRecentApproved(20);
      const posters = await Promise.all(
        recent.map(async (item) => ({
          ...item,
          poster: await getPoster(item.imdb_id),
        }))
      );
      
      const html = `
        <html>
          <head>
            <title>Movie Trailers</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css" rel="stylesheet">
          </head>
          <body class="bg-gray-100">
            <header class="bg-gray-800 text-white p-4">
              <div class="container mx-auto text-center">
                <h1 class="text-3xl font-bold">
                  <i class="fa fa-film mr-2"></i>Movie Trailers Archive
                </h1>
                <p class="mt-2">Recent approved submissions</p>
              </div>
            </header>
            
            <main class="container mx-auto p-4">
              <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                ${posters.map(item => `
                  <div class="bg-white rounded-lg overflow-hidden shadow-md hover:shadow-lg transition-shadow">
                    ${item.poster ? `
                      <img src="${item.poster}" alt="Poster for ${item.imdb_id}" class="w-full h-64 object-cover">
                    ` : `
                      <div class="w-full h-64 bg-gray-200 flex items-center justify-center">
                        <i class="fa fa-film text-5xl text-gray-400"></i>
                      </div>
                    `}
                    <div class="p-4">
                      <div class="text-sm text-gray-500 mb-2">IMDb ID: ${item.imdb_id}</div>
                      <a href="${item.acfun_url}" target="_blank" class="text-blue-600 hover:underline flex items-center">
                        <i class="fa fa-external-link mr-1"></i>Watch on AcFun
                      </a>
                      <div class="mt-2 text-xs text-gray-500">
                        Approved: ${new Date(item.approved_at).toLocaleString()}
                      </div>
                      <div class="text-xs text-gray-500">
                        By: ${item.reviewer}
                      </div>
                    </div>
                  </div>
                `).join("")}
              </div>
              
              ${posters.length === 0 ? `
                <div class="mt-8 text-center bg-white p-6 rounded-lg">
                  <i class="fa fa-info-circle text-blue-500 text-3xl mb-2"></i>
                  <p>No approved submissions yet</p>
                </div>
              ` : ""}
            </main>
            
            <footer class="bg-gray-800 text-white p-4 mt-8">
              <div class="container mx-auto text-center text-sm">
                <p>&copy; ${new Date().getFullYear()} Movie Trailers Archive</p>
              </div>
            </footer>
          </body>
        </html>
      `;
      
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return new Response(`Error loading homepage: ${error.message}`, { status: 500 });
    }
  }

  // 404页面
  return new Response("Not found", { status: 404 });
}

// 启动服务器
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on http://localhost:${port}`);

// 使用正确的serve函数调用
serve(handleRequest, { port });

// 正确的关闭事件监听
globalThis.addEventListener("unload", () => {
  closeDb();
});
