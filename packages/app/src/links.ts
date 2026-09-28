import {
  type Choice,
  commandId,
  decodeInvite,
  fromBase64,
  type KeyPair,
  LinkClient,
  type LinkStatus,
  type LoggedEvent,
  pair,
  type QuestionKind,
  type Risk,
  type TaskState,
  toBase64,
  type Welcome,
} from "@malves/protocol";
import { type Computer, loadComputers, phoneKeys, saveComputers } from "./storage";

export type TaskView = {
  runnerId: string;
  id: string;
  workspaceId: string;
  agent: string;
  prompt: string;
  state: TaskState;
  reason?: string;
  result?: string;
  updatedAt: number;
  /** Models that answered through the budget guard, and how (R8). */
  models: Array<{ model: string; via: "free" | "own_key"; tokens: number }>;
};

export type QuestionView = {
  runnerId: string;
  id: string;
  taskId: string;
  kind: QuestionKind;
  text: string;
  choices: Choice[];
  risk: Risk;
  expiresAt: number;
};

export type ComputerView = Computer & { status: LinkStatus; welcome?: Welcome };

export type AppState = {
  ready: boolean;
  computers: ComputerView[];
  tasks: TaskView[];
  questions: QuestionView[];
};

type Listener = () => void;

/**
 * Everything the app knows, rebuilt from each computer's event log. The phone
 * stores nothing but keys and the list of computers: the runner's log is the
 * truth, and a fresh start simply replays it.
 */
class Links {
  private keys: KeyPair | undefined;
  private readonly clients = new Map<string, LinkClient>();
  private readonly tasks = new Map<string, TaskView>();
  private readonly questions = new Map<string, QuestionView>();
  private readonly computers = new Map<string, ComputerView>();
  private readonly listeners = new Set<Listener>();
  private snapshot: AppState = { ready: false, computers: [], tasks: [], questions: [] };
  private started: Promise<void> | undefined;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  start(): Promise<void> {
    this.started ??= (async () => {
      this.keys = await phoneKeys();
      for (const computer of await loadComputers()) this.connect(computer);
      this.changed(true);
    })();
    return this.started;
  }

  /** Pairs with the computer whose QR code was scanned. */
  async addComputer(qrText: string, phoneName: string): Promise<void> {
    await this.start();
    const invite = decodeInvite(qrText);
    const keys = this.keys as KeyPair;
    const result = await pair(invite, keys, phoneName);
    const computer: Computer = {
      runnerId: result.runnerId,
      name: result.name,
      url: invite.url,
      publicKey: toBase64(invite.publicKey),
      deviceId: result.deviceId,
    };
    const all = [
      ...(await loadComputers()).filter((c) => c.runnerId !== computer.runnerId),
      computer,
    ];
    await saveComputers(all);
    this.disconnect(computer.runnerId);
    this.connect(computer);
    this.changed();
  }

  async removeComputer(runnerId: string): Promise<void> {
    await saveComputers((await loadComputers()).filter((c) => c.runnerId !== runnerId));
    this.disconnect(runnerId);
    this.changed();
  }

  async answer(question: QuestionView, choiceId: string): Promise<string> {
    const ack = await this.client(question.runnerId).send({
      t: "answer",
      id: commandId(),
      question_id: question.id,
      choice_id: choiceId,
    });
    return ack.result;
  }

  async createTask(input: {
    runnerId: string;
    workspaceId: string;
    agent: string;
    prompt: string;
    browser?: boolean;
  }): Promise<void> {
    await this.client(input.runnerId).send({
      t: "task.create",
      id: commandId(),
      workspace_id: input.workspaceId,
      agent: input.agent,
      prompt: input.prompt,
      ...(input.browser ? { browser: true } : {}),
    });
  }

  async stopTask(task: TaskView): Promise<void> {
    await this.client(task.runnerId).send({ t: "task.stop", id: commandId(), task_id: task.id });
  }

  /** Sends the push subscription to every computer (see push.ts). */
  async registerPush(
    runnerId: string,
    subscription: { endpoint: string; p256dh: string; auth: string },
  ) {
    await this.client(runnerId).send({ t: "push.register", id: commandId(), subscription });
  }

  private client(runnerId: string): LinkClient {
    const client = this.clients.get(runnerId);
    if (!client) throw new Error("That computer is no longer paired.");
    return client;
  }

  private connect(computer: Computer): void {
    const view: ComputerView = { ...computer, status: { state: "connecting", attempt: 1 } };
    this.computers.set(computer.runnerId, view);
    const client = new LinkClient({
      url: computer.url,
      runnerPublicKey: fromBase64(computer.publicKey),
      keyPair: this.keys as KeyPair,
      onStatus: (status) => {
        const current = this.computers.get(computer.runnerId);
        if (current) this.computers.set(computer.runnerId, { ...current, status });
        this.changed();
      },
      onWelcome: (welcome) => {
        const current = this.computers.get(computer.runnerId);
        if (current) this.computers.set(computer.runnerId, { ...current, welcome });
        this.changed();
      },
      onEvent: (event) => {
        this.fold(computer.runnerId, event);
        this.changed();
      },
    });
    this.clients.set(computer.runnerId, client);
    client.start();
  }

  private disconnect(runnerId: string): void {
    this.clients.get(runnerId)?.stop();
    this.clients.delete(runnerId);
    this.computers.delete(runnerId);
    for (const [key, t] of this.tasks) if (t.runnerId === runnerId) this.tasks.delete(key);
    for (const [key, q] of this.questions) if (q.runnerId === runnerId) this.questions.delete(key);
  }

  private fold(runnerId: string, event: LoggedEvent): void {
    const key = (id: string) => `${runnerId}/${id}`;
    switch (event.type) {
      case "task.created": {
        const d = event.data;
        this.tasks.set(key(d.task_id), {
          runnerId,
          id: d.task_id,
          workspaceId: d.workspace_id,
          agent: d.agent,
          prompt: d.prompt,
          state: "queued",
          updatedAt: event.at,
          models: [],
        });
        break;
      }
      case "budget.updated": {
        const task = this.tasks.get(key(event.data.task_id));
        if (!task) break;
        const { model, via } = event.data;
        const tokens = event.data.input_tokens + event.data.output_tokens;
        const models = [...task.models];
        const same = models.findIndex((m) => m.model === model && m.via === via);
        if (same >= 0) models[same] = { model, via, tokens: (models[same]?.tokens ?? 0) + tokens };
        else models.push({ model, via, tokens });
        this.tasks.set(key(task.id), { ...task, models });
        break;
      }
      case "task.updated": {
        const task = this.tasks.get(key(event.data.task_id));
        if (!task) break;
        const { reason: _old, ...rest } = task;
        this.tasks.set(key(task.id), {
          ...rest,
          state: event.data.state,
          ...(event.data.reason ? { reason: event.data.reason } : {}),
          updatedAt: event.at,
        });
        break;
      }
      case "task.result": {
        const task = this.tasks.get(key(event.data.task_id));
        if (task) this.tasks.set(key(task.id), { ...task, result: event.data.text });
        break;
      }
      case "question.opened": {
        const d = event.data;
        this.questions.set(key(d.question_id), {
          runnerId,
          id: d.question_id,
          taskId: d.task_id,
          kind: d.kind,
          text: d.text,
          choices: d.choices,
          risk: d.risk,
          expiresAt: d.expires_at,
        });
        break;
      }
      case "question.closed":
        this.questions.delete(key(event.data.question_id));
        break;
    }
  }

  private changed(ready = this.snapshot.ready): void {
    this.snapshot = {
      ready,
      computers: [...this.computers.values()],
      tasks: [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      questions: [...this.questions.values()].sort((a, b) => a.expiresAt - b.expiresAt),
    };
    for (const listener of this.listeners) listener();
  }
}

export const links = new Links();
