const form = document.querySelector('[data-demo-form]');
const status = document.querySelector('[data-demo-status]');

if (form instanceof HTMLFormElement && status instanceof HTMLElement) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    if (submit instanceof HTMLButtonElement) submit.disabled = true;
    status.textContent = 'Sending your request...';
    status.dataset.state = 'pending';

    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      const response = await fetch('/api/public/demo-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to submit the request.');
      form.reset();
      status.textContent = `Request received. Reference: ${result.requestId || 'accepted'}.`;
      status.dataset.state = 'success';
    } catch (error) {
      status.textContent = `${error instanceof Error ? error.message : 'Unable to submit.'} Email info@right-api.com instead.`;
      status.dataset.state = 'error';
    } finally {
      if (submit instanceof HTMLButtonElement) submit.disabled = false;
    }
  });
}
