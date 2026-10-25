/**
 * What the main process and the video process say to each other (over Node's
 * built-in IPC, as JSON). The video process does the capturing and the WebRTC;
 * the main process only passes the phone's offer in and the answer back.
 */
export type ToVideo = { t: "start"; id: number; sdp: string } | { t: "stop" };

export type FromVideo =
  | { t: "ready" }
  | { t: "answer"; id: number; sdp: string; width: number; height: number }
  | { t: "error"; id: number; message: string }
  | { t: "log"; line: string };
