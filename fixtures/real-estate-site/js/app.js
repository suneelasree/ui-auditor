// Harbor Homes site script: "Save" buttons on listing cards toggle a saved state.
document.querySelectorAll('.save-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var saved = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', String(!saved));
    btn.textContent = saved ? 'Save' : 'Saved';
  });
});
