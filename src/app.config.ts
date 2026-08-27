import { defineServer, defineRoom, monitor, playground } from "colyseus";

import { RaceRoom } from "./rooms/RaceRoom.js";

const server = defineServer({
  rooms: {
    /**
     * One room is one match. `joinOrCreate` fills a room to its 6-player cap
     * before opening another, which is what keeps a "small match" small - and
     * realtime listing lets the client show how the lobby is filling up.
     */
    race: defineRoom(RaceRoom).enableRealtimeListing(),
  },

  express: (app) => {
    app.get("/healthz", (_req, res) => { res.json({ ok: true }); });

    if (process.env.NODE_ENV !== "production") {
      app.use("/playground", playground());
      app.use("/monitor", monitor());
    }
  },
});

export default server;

/** Named export read by the `colyseus/vite` plugin's `serverEntry`. */
export { server };
