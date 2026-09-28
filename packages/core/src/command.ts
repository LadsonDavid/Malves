declare const commandBrand: unique symbol;

/**
 * A program and its arguments, kept apart. Adapters start processes only from a
 * Command, never from a string, so nothing is ever parsed by a shell (§8
 * "Nothing built from strings"). The brand means a Command can only come from
 * `command()`.
 */
export type Command = {
  readonly program: string;
  readonly args: readonly string[];
  readonly [commandBrand]: true;
};

export function command(program: string, args: readonly string[] = []): Command {
  if (program.length === 0) throw new Error("command: program is empty");
  for (const part of [program, ...args]) {
    if (part.includes("\0")) throw new Error("command: NUL byte in argument");
  }
  return Object.freeze({ program, args: Object.freeze([...args]) }) as Command;
}
