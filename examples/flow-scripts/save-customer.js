if (signal.aborted) throw new Error('已取消');
const form = document.querySelector('#customer-form');
if (!form || !location.pathname.endsWith('/demo')) throw new Error('脚本仅适用于 Auto Browser 本地客户练习页面');
if (!form.checkValidity()) throw new Error('必填字段或邮箱校验未通过');
form.requestSubmit();
await new Promise(resolve => setTimeout(resolve, 150));
const message = document.querySelector('#result').textContent.trim();
const name = document.querySelector('#name').value;
return { message, matchesCustomer: message.startsWith(`已保存：${name} · 编号 DEMO-`), recordId: message.match(/DEMO-\d+/)?.[0] || null };
