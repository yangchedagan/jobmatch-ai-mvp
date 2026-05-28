(function () {
  function $(selector) {
    return document.querySelector(selector);
  }

  function $$(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  function activatePage(page) {
    var targetPage = ["report", "intelligence"].includes(page) ? page : "workbench";
    $$(".page-view").forEach(function (view) {
      view.classList.toggle("active", view.id === targetPage + "Page");
    });
    $$(".view-tab").forEach(function (tab) {
      tab.classList.toggle("active", tab.dataset.page === targetPage);
    });
    if (window.location.hash !== "#" + targetPage) {
      window.history.pushState(null, "", "#" + targetPage);
    }
    window.scrollTo(0, 0);
  }

  function enter(page) {
    var cover = $("#coverPage");
    if (cover) {
      cover.hidden = true;
      cover.classList.remove("leaving");
    }
    document.body.classList.remove("cover-visible");
    activatePage(page);
  }

  function bindCoverButton(selector, page) {
    var button = $(selector);
    if (!button) return;
    button.addEventListener("click", function () {
      enter(page);
    });
  }

  function init() {
    bindCoverButton("#coverPathBtn", "workbench");
    bindCoverButton("#coverWorkbenchBtn", "workbench");
    bindCoverButton("#coverEnterBtn", "workbench");
    bindCoverButton("#coverMatchBtn", "report");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
