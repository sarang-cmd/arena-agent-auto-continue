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

  const closeDialog = () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    open.focus();
  };

  open.addEventListener('click', openDialog);
  if (closeBtn) closeBtn.addEventListener('click', closeDialog);

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
