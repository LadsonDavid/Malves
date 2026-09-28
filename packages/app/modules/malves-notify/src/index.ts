import { requireOptionalNativeModule } from "expo";

type MalvesNotify = {
  finish(runner: string, question: string, text: string): void;
  cancel(runner: string, question: string): void;
};

/** Undefined outside a development build (e.g. in tests or Expo Go). */
export const MalvesNotify = requireOptionalNativeModule<MalvesNotify>("MalvesNotify") ?? undefined;
