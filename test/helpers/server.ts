/**
 * One booted test server for the whole run.
 *
 * `boot()` binds a real port, so two suites that each boot their own race for
 * it and the loser fails to match-make. Sharing one is also simply faster:
 * booting is by far the most expensive thing in the suite.
 *
 * Nothing shuts it down on purpose. Reference counting does not work here -
 * suites run one after another, so the first one to finish would take the
 * server away from the next - and `mocha --exit` already owns teardown.
 */

import { boot, type ColyseusTestServer } from "@colyseus/testing";

import appConfig from "../../src/app.config.js";

let booted: Promise<ColyseusTestServer<typeof appConfig>> | null = null;

export function useTestServer(): Promise<ColyseusTestServer<typeof appConfig>> {
  booted ??= boot(appConfig);
  return booted;
}
