import { setRandomSource } from "@malves/protocol";
import { registerRootComponent } from "expo";
import { getRandomValues } from "expo-crypto";
import { AppRegistry } from "react-native";
import App from "./App";
import { answerFromNotification } from "./src/answer-task";

// tweetnacl needs a secure random source on React Native (§15). Must run first.
setRandomSource((bytes) => {
  getRandomValues(bytes);
});

// Notification buttons answer through this headless task (R1).
AppRegistry.registerHeadlessTask("MalvesAnswer", () => answerFromNotification);

registerRootComponent(App);
