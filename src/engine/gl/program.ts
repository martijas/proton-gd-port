// Shader compilation, with errors a person can act on.
//
// A driver reports a shader error as a line number into the source it was
// given, which is useless once the source is a template literal several files
// away, so a failure here prints the offending line with its neighbours.

/** What a build started in the background still needs to be checked. */
interface PendingBuild {
  vs: WebGLShader;
  fs: WebGLShader;
  vertexSource: string;
  fragmentSource: string;
}

export class Program {
  readonly program: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  /** KHR_parallel_shader_compile, for a program built in the background; null otherwise. */
  private readonly parallel: KHR_parallel_shader_compile | null;
  /** The build the driver may still be working on; null once it has been checked. */
  private pending: PendingBuild | null;

  /**
   * Compiles and links. By default this waits for the driver, as asking
   * whether a compile worked does. With `background` and a browser that
   * offers KHR_parallel_shader_compile it only starts the work, which the
   * driver does on threads of its own; `linked` says when it is done without
   * waiting. A browser without the extension builds it at once either way.
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
    readonly name = "program",
    background = false,
  ) {
    // Enabled before the compile starts, so the driver knows it may be asked.
    this.parallel = background ? gl.getExtension("KHR_parallel_shader_compile") : null;
    const vs = this.compile(gl.VERTEX_SHADER, vertexSource, "vertex");
    const fs = this.compile(gl.FRAGMENT_SHADER, fragmentSource, "fragment");
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error(`${name}: could not create a program`);
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    this.program = program;
    this.pending = { vs, fs, vertexSource, fragmentSource };
    if (!this.parallel) this.finish();
  }

  /**
   * Whether the program can be drawn with: always, unless it is still being
   * built in the background, which this asks without waiting. Throws a failed
   * compile or link, as the constructor does for one it builds at once.
   */
  linked(): boolean {
    if (!this.pending) return true;
    if (this.parallel && !this.gl.getProgramParameter(this.program, this.parallel.COMPLETION_STATUS_KHR)) return false;
    this.finish();
    return true;
  }

  /** Checks the build, throwing the driver's complaint if it failed. */
  private finish(): void {
    const build = this.pending;
    if (!build) return;
    this.pending = null;
    const gl = this.gl;
    try {
      this.check(build.vs, build.vertexSource, "vertex");
      this.check(build.fs, build.fragmentSource, "fragment");
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        throw new Error(`${this.name}: link failed\n${gl.getProgramInfoLog(this.program) ?? ""}`);
      }
    } catch (e) {
      gl.deleteProgram(this.program);
      throw e;
    } finally {
      gl.deleteShader(build.vs);
      gl.deleteShader(build.fs);
    }
  }

  private compile(type: number, source: string, what: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error(`${this.name}: could not create the ${what} shader`);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  private check(shader: WebGLShader, source: string, what: string): void {
    const gl = this.gl;
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return;
    const log = gl.getShaderInfoLog(shader) ?? "";
    throw new Error(`${this.name}: the ${what} shader did not compile\n${log}\n${annotate(source, log)}`);
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  location(name: string): WebGLUniformLocation | null {
    let at = this.uniforms.get(name);
    if (at === undefined) {
      at = this.gl.getUniformLocation(this.program, name);
      this.uniforms.set(name, at);
    }
    return at;
  }
}

/** Pulls the line the driver complained about out of the source. */
function annotate(source: string, log: string): string {
  const match = /ERROR:\s*\d+:(\d+)/.exec(log);
  if (!match) return "";
  const line = Number(match[1]);
  const lines = source.split("\n");
  const from = Math.max(0, line - 3);
  const to = Math.min(lines.length, line + 2);
  return lines
    .slice(from, to)
    .map((text, i) => `${String(from + i + 1).padStart(4)}${from + i + 1 === line ? " >" : "  "} ${text}`)
    .join("\n");
}
