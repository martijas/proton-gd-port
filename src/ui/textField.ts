// A line of text the player types, for the search page.
//
// The game draws its own field and caret, and so does this; but the typing
// goes into a real <input> kept out of sight, because that is the only thing
// that brings up a phone's keyboard, and it handles pasting, selection and
// every keyboard layout for free. The screen draws `value` and `focused`; it
// never reads a key itself.

export interface TextFieldOptions {
  maxLength: number;
  /** Enter, or the keyboard's own search key. */
  onSubmit: () => void;
  /** What the characters may be; anything else is dropped as it is typed. */
  allowed?: RegExp;
}

export class TextField {
  private readonly input: HTMLInputElement;
  private readonly allowed: RegExp;

  constructor(private readonly opts: TextFieldOptions) {
    this.allowed = opts.allowed ?? /[\x20-\x7e]/;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = opts.maxLength;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.enterKeyHint = "search";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("aria-label", "Search");
    // Out of sight but focusable. 16px stops iOS zooming the page on focus,
    // and the page's own no-select rule would otherwise stop typing in Safari.
    Object.assign(input.style, {
      position: "fixed",
      left: "0",
      bottom: "0",
      width: "1px",
      height: "1px",
      opacity: "0",
      border: "0",
      padding: "0",
      fontSize: "16px",
      pointerEvents: "none",
      userSelect: "text",
      webkitUserSelect: "text",
    } as Partial<CSSStyleDeclaration>);
    input.addEventListener("input", () => {
      const clean = [...input.value].filter((c) => this.allowed.test(c)).join("");
      if (clean !== input.value) input.value = clean;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
        this.opts.onSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.blur();
      }
    });
    document.body.append(input);
    this.input = input;
  }

  get value(): string {
    return this.input.value;
  }

  set value(v: string) {
    this.input.value = v.slice(0, this.opts.maxLength);
  }

  get focused(): boolean {
    return document.activeElement === this.input;
  }

  /** Must be called from a press, or a phone will not raise its keyboard. */
  focus(): void {
    this.input.focus();
    const end = this.input.value.length;
    this.input.setSelectionRange(end, end);
  }

  blur(): void {
    this.input.blur();
  }

  dispose(): void {
    this.input.blur();
    this.input.remove();
  }
}
