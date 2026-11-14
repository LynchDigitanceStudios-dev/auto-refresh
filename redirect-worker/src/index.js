// Forwards the retired auto-refresh.* address to autorefresh.* — same path and
// query — so old links and 2.1.0's update check keep working.
const TARGET = "https://autorefresh.lynchdigitancestudios.workers.dev";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    return new Response(null, {
      status: 301,
      headers: {
        Location: TARGET + url.pathname + url.search,
        // The extension's update check reads this cross-origin.
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
};
