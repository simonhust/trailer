// 加载管理员列表
async function loadAdminList() {
  try {
    const response = await fetch('/admin/api/admins');
    if (!response.ok) {
      throw new Error('Failed to load admins');
    }
    
    const admins = await response.json();
    const tableBody = document.getElementById('adminList');
    
    if (!tableBody) return;
    
    // 清空现有内容
    tableBody.innerHTML = '';
    
    // 添加管理员列表项
    admins.forEach(admin => {
      const row = document.createElement('tr');
      row.className = 'hover:bg-gray-50';
      
      row.innerHTML = `
        <td class="py-2 px-4 border-b">${admin.username}</td>
        <td class="py-2 px-4 border-b">
          <span class="px-2 py-1 rounded text-xs ${
            admin.role === 'super' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
          }">
            ${admin.role === 'super' ? 'Super Admin' : 'Secondary Admin'}
          </span>
        </td>
        <td class="py-2 px-4 border-b">
          ${new Date(admin.created_at).toLocaleString()}
        </td>
      `;
      
      tableBody.appendChild(row);
    });
  } catch (error) {
    showAdminMessage(error.message, 'error');
  }
}

// 显示管理员操作消息
function showAdminMessage(text, type = 'info') {
  const messageEl = document.getElementById('adminMessage');
  if (!messageEl) return;
  
  messageEl.textContent = text;
  messageEl.className = `mt-2 p-2 rounded ${
    type === 'error' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
  }`;
  
  // 3秒后自动隐藏
  setTimeout(() => {
    messageEl.className = 'mt-2 hidden';
  }, 3000);
}

// 初始化添加管理员表单
function initAddAdminForm() {
  const form = document.getElementById('addAdminForm');
  if (!form) return;
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = form.querySelector('input[name="username"]').value.trim();
    const password = form.querySelector('input[name="password"]').value.trim();
    
    if (!username || !password) {
      showAdminMessage('Username and password are required', 'error');
      return;
    }
    
    try {
      const response = await fetch('/admin/api/admins', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to add admin');
      }
      
      showAdminMessage(`Admin "${username}" added successfully`);
      
      // 重置表单并刷新列表
      form.reset();
      loadAdminList();
    } catch (error) {
      showAdminMessage(error.message, 'error');
    }
  });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
  // 只有超级管理员页面才有这些元素
  if (document.getElementById('adminList')) {
    loadAdminList();
    initAddAdminForm();
  }
});
    
