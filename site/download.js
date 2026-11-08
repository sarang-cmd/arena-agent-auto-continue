/* Download chooser: a native dialog so focus, Escape and screen readers work
   without extra code. Two destinations, same artifact. */
(() => {
  const dialog = document.getElementById('downloadDialog');
  const open = document.getElementById('downloadBtn');
  if (!dialog || !open) return;

  const closeBtn = document.getElementById('downloadClose');
  const direct = document.getElementById('directDownload');
  const source = document.getElementById('sourceDownload');

  const openDialog = () => {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    // focus the first option, not the close button
    if (direct) direct.focus();
  };

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let closing = false;

  const finish = () => {
    closing = false;
    dialog.removeAttribute('data-closing');
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    open.focus();
  };

  // Animate out, then close, so the sheet does not vanish mid-transition.
  const closeDialog = () => {
    if (closing) return;
    if (reduce.matches || typeof dialog.close !== 'function') {
      finish();
      return;
    }
    closing = true;
    dialog.setAttribute('data-closing', '');
    setTimeout(finish, 190);
  };

  open.addEventListener('click', openDialog);
  if (closeBtn) closeBtn.addEventListener('click', closeDialog);

  // Escape is the browser's job, so take it over just long enough to animate.
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeDialog();
  });

  // clicking the backdrop closes it, which is what people expect of a sheet
  dialog.addEventListener('click', (e) => {
    const r = dialog.getBoundingClientRect();
    const outside =
      e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) closeDialog();
  });

  // the direct download closes the sheet so the download bar is visible
  if (direct) {
    direct.addEventListener('click', () => {
      setTimeout(closeDialog, 60);
    });
  }
  if (source) {
    source.addEventListener('click', () => {
      setTimeout(closeDialog, 60);
    });
  }
})();
