// 1.19.0: Home starts with the search form folded into a "Plan a trip" bar.
// A user taps the bar before typing; this makes every page.fill on the From /
// To fields do the same, so the sessions keep driving the real UI.
module.exports = function openFormBeforeFill(page) {
  const fill = page.fill.bind(page);
  page.fill = async (selector, value, opts) => {
    if (/^#(from|to)-input$/.test(selector) && !(await page.isVisible(selector).catch(() => true))) {
      await page.click('#search-summary').catch(() => {});
      await page.waitForSelector(selector, { state: 'visible', timeout: 5000 }).catch(() => {});
    }
    return fill(selector, value, opts);
  };
  return page;
};
