import COMMANDS from '../commands';
import RedisMultiCommand, { MULTI_REPLY, MultiReply, MultiReplyType, RedisMultiQueuedCommand } from '../multi-command';
import { ReplyWithTypeMapping, CommandReply, Command, CommandArguments, CommanderConfig, RedisFunctions, RedisModules, RedisScripts, RespVersions, TransformReply, RedisScript, RedisFunction, TypeMapping, RedisArgument } from '../RESP/types';
import { attachConfig, functionArgumentsPrefix, getTransformReply } from '../commander';
import { BasicCommandParser } from '../client/parser';
import { Tail } from '../commands/generic-transformers';

type CommandSignature<
  REPLIES extends Array<unknown>,
  C extends Command,
  M extends RedisModules,
  F extends RedisFunctions,
  S extends RedisScripts,
  RESP extends RespVersions,
  TYPE_MAPPING extends TypeMapping
> = (...args: Tail<Parameters<C['parseCommand']>>) => RedisClusterMultiCommandType<
  [...REPLIES, ReplyWithTypeMapping<CommandReply<C, RESP>, TYPE_MAPPING>],
  M,
  F,
  S,
  RESP,
  TYPE_MAPPING
>;

type WithCommands<
  REPLIES extends Array<unknown>,
  M extends RedisModules,
  F extends RedisFunctions,
  S extends RedisScripts,
  RESP extends RespVersions,
  TYPE_MAPPING extends TypeMapping
> = {
  [P in keyof typeof COMMANDS]: CommandSignature<REPLIES, (typeof COMMANDS)[P], M, F, S, RESP, TYPE_MAPPING>;
};

type WithModules<
  REPLIES extends Array<unknown>,
  M extends RedisModules,
  F extends RedisFunctions,
  S extends RedisScripts,
  RESP extends RespVersions,
  TYPE_MAPPING extends TypeMapping
> = {
  [P in keyof M]: {
    [C in keyof M[P]]: CommandSignature<REPLIES, M[P][C], M, F, S, RESP, TYPE_MAPPING>;
  };
};

type WithFunctions<
  REPLIES extends Array<unknown>,
  M extends RedisModules,
  F extends RedisFunctions,
  S extends RedisScripts,
  RESP extends RespVersions,
  TYPE_MAPPING extends TypeMapping
> = {
  [L in keyof F]: {
    [C in keyof F[L]]: CommandSignature<REPLIES, F[L][C], M, F, S, RESP, TYPE_MAPPING>;
  };
};

type WithScripts<
  REPLIES extends Array<unknown>,
  M extends RedisModules,
  F extends RedisFunctions,
  S extends RedisScripts,
  RESP extends RespVersions,
  TYPE_MAPPING extends TypeMapping
> = {
  [P in keyof S]: CommandSignature<REPLIES, S[P], M, F, S, RESP, TYPE_MAPPING>;
};

export type RedisClusterMultiCommandType<
  REPLIES extends Array<any>,
  M extends RedisModules,
  F extends RedisFunctions,
  S extends RedisScripts,
  RESP extends RespVersions,
  TYPE_MAPPING extends TypeMapping
> = (
  RedisClusterMultiCommand<REPLIES> &
  WithCommands<REPLIES, M, F, S, RESP, TYPE_MAPPING> & 
  WithModules<REPLIES, M, F, S, RESP, TYPE_MAPPING> &
  WithFunctions<REPLIES, M, F, S, RESP, TYPE_MAPPING> &
  WithScripts<REPLIES, M, F, S, RESP, TYPE_MAPPING>
);

export type ClusterMultiExecute = (
  firstKey: RedisArgument | undefined,
  isReadonly: boolean | undefined,
  commands: Array<RedisMultiQueuedCommand>
) => Promise<Array<unknown>>;

export default class RedisClusterMultiCommand<REPLIES = []> {
  static #createCommand(command: Command, resp: RespVersions) {
    const transformReply = getTransformReply(command, resp);

    return function (this: RedisClusterMultiCommand, ...args: Array<unknown>) {
      const parser = new BasicCommandParser();
      command.parseCommand(parser, ...args);

      const redisArgs: CommandArguments = parser.redisArgs;
      redisArgs.preserve = parser.preserve;
      const firstKey = parser.firstKey;
      
      return this.addCommand(
        firstKey,
        command.IS_READ_ONLY,
        redisArgs,
        transformReply
      );
    };
  }

  static #createModuleCommand(command: Command, resp: RespVersions) {
    const transformReply = getTransformReply(command, resp);

    return function (this: { _self: RedisClusterMultiCommand }, ...args: Array<unknown>) {
      const parser = new BasicCommandParser();
      command.parseCommand(parser, ...args);

      const redisArgs: CommandArguments = parser.redisArgs;
      redisArgs.preserve = parser.preserve;
      const firstKey = parser.firstKey;

      return this._self.addCommand(
        firstKey,
        command.IS_READ_ONLY,
        redisArgs,
        transformReply
      );
    };
  }

  static #createFunctionCommand(name: string, fn: RedisFunction, resp: RespVersions) {
    const prefix = functionArgumentsPrefix(name, fn);
    const transformReply = getTransformReply(fn, resp);

    return function (this: { _self: RedisClusterMultiCommand }, ...args: Array<unknown>) {
      const parser = new BasicCommandParser();
      parser.push(...prefix);
      fn.parseCommand(parser, ...args);

      const redisArgs: CommandArguments = parser.redisArgs;
      redisArgs.preserve = parser.preserve;
      const firstKey = parser.firstKey;

      return this._self.addCommand(
        firstKey,
        fn.IS_READ_ONLY,
        redisArgs,
        transformReply
      );
    };
  }

  static #createScriptCommand(script: RedisScript, resp: RespVersions) {
    const transformReply = getTransformReply(script, resp);

    return function (this: RedisClusterMultiCommand, ...args: Array<unknown>) {
      const parser = new BasicCommandParser();
      script.parseCommand(parser, ...args);

      const scriptArgs: CommandArguments = parser.redisArgs;
      scriptArgs.preserve = parser.preserve;
      const firstKey = parser.firstKey;

      return this.#addScript(
        firstKey,
        script.IS_READ_ONLY,
        script,
        scriptArgs,
        transformReply
      );
    };
  }

  static extend<
    M extends RedisModules = Record<string, never>,
    F extends RedisFunctions = Record<string, never>,
    S extends RedisScripts = Record<string, never>,
    RESP extends RespVersions = 2
  >(config?: CommanderConfig<M, F, S, RESP>) {
    return attachConfig({
      BaseClass: RedisClusterMultiCommand,
      commands: COMMANDS,
      createCommand: RedisClusterMultiCommand.#createCommand,
      createModuleCommand: RedisClusterMultiCommand.#createModuleCommand,
      createFunctionCommand: RedisClusterMultiCommand.#createFunctionCommand,
      createScriptCommand: RedisClusterMultiCommand.#createScriptCommand,
      config
    });
  }

  readonly #multi: RedisMultiCommand

  readonly #executeMulti: ClusterMultiExecute;
  readonly #executePipeline: ClusterMultiExecute;
  #firstKey: RedisArgument | undefined;
  #isReadonly: boolean | undefined = true;

  constructor(
    executeMulti: ClusterMultiExecute,
    executePipeline: ClusterMultiExecute,
    routing: RedisArgument | undefined,
    typeMapping?: TypeMapping
  ) {
    this.#multi = new RedisMultiCommand(typeMapping);
    this.#executeMulti = executeMulti;
    this.#executePipeline = executePipeline;
    this.#firstKey = routing;
  }

  #setState(
    firstKey: RedisArgument | undefined,
    isReadonly: boolean | undefined,
  ) {
    this.#firstKey ??= firstKey;
    this.#isReadonly &&= isReadonly;
  }

  addCommand(
    firstKey: RedisArgument | undefined,
    isReadonly: boolean | undefined,
    args: CommandArguments,
    transformReply?: TransformReply
  ) {
    this.#setState(firstKey, isReadonly);
    this.#multi.addCommand(args, transformReply);
    return this;
  }

  #addScript(
    firstKey: RedisArgument | undefined,
    isReadonly: boolean | undefined,
    script: RedisScript,
    args: CommandArguments,
    transformReply?: TransformReply
  ) {
    this.#setState(firstKey, isReadonly);
    this.#multi.addScript(script, args, transformReply);

    return this;
  }

  async exec<T extends MultiReply = MULTI_REPLY['GENERIC']>(execAsPipeline = false) {
    if (execAsPipeline) return this.execAsPipeline<T>();

    return this.#multi.transformReplies(
      await this.#executeMulti(
        this.#firstKey,
        this.#isReadonly,
        this.#multi.queue
      )
    ) as MultiReplyType<T, REPLIES>;
  }

  EXEC = this.exec;

  execTyped(execAsPipeline = false) {
    return this.exec<MULTI_REPLY['TYPED']>(execAsPipeline);
  }

  async execAsPipeline<T extends MultiReply = MULTI_REPLY['GENERIC']>() {
    if (this.#multi.queue.length === 0) return [] as MultiReplyType<T, REPLIES>;

    return this.#multi.transformReplies(
      await this.#executePipeline(
        this.#firstKey,
        this.#isReadonly,
        this.#multi.queue
      )
    ) as MultiReplyType<T, REPLIES>;
  }

  execAsPipelineTyped() {
    return this.execAsPipeline<MULTI_REPLY['TYPED']>();
  }
}
