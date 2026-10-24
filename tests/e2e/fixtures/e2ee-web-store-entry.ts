import E2eeWeb from "../../../apps/mobile/modules/halochat-e2ee/src/index.web";
import {
  initializeE2eeDevice,
  loadE2eeStateRecord,
  getE2eeContext,
  saveE2eeState,
} from "../../../apps/mobile/src/crypto/state-store.web";

Object.assign(globalThis, {
  E2eeWeb,
  getE2eeContext,
  initializeE2eeDevice,
  loadE2eeStateRecord,
  saveE2eeState,
});
