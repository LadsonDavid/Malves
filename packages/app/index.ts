import { setRandomSource } from "@malves/protocol";
import { registerRootComponent } from "expo";
import * as Crypto from "expo-crypto";
import App from "./App";

// Encryption needs secure random bytes; React Native's come from expo-crypto.
// Must run before any key, nonce or command id is made.
setRandomSource((bytes) => {
  Crypto.getRandomValues(bytes);
});

registerRootComponent(App);
