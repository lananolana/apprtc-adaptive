// toast.js — простая система всплывающих уведомлений.
//
// Контейнер #toastContainer создаётся в index.html. Каждый тост — это div,
// который появляется снизу справа, держится N миллисекунд и исчезает.

const DEFAULT_DURATION = 4500;

function ensureContainer() {
  let c = document.getElementById('toastContainer');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toastContainer';
    document.body.appendChild(c);
  }
  return c;
}

/**
 * @param {string} message
 * @param {{ type?: 'info'|'warn'|'success'|'error', duration?: number }} [opts]
 */
export function showToast(message, opts = {}) {
  const type = opts.type || 'info';
  const duration = opts.duration ?? DEFAULT_DURATION;
  const container = ensureContainer();

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  el.addEventListener('click', () => dismiss(el));
  container.appendChild(el);

  // запускаем анимацию появления на следующем тике
  requestAnimationFrame(() => el.classList.add('toast-show'));

  const t = setTimeout(() => dismiss(el), duration);
  el._timer = t;
  return el;
}

function dismiss(el) {
  if (!el || el._dismissed) return;
  el._dismissed = true;
  clearTimeout(el._timer);
  el.classList.remove('toast-show');
  el.classList.add('toast-hide');
  setTimeout(() => el.parentNode?.removeChild(el), 300);
}
