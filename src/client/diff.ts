/** Word differences between two texts, drawn as deleted and inserted runs. */

/** Past this many cells the comparison runs line by line, then gives up and shows both texts whole. */
const MAX_CELLS = 4_000_000;

type Run = { kind: "same" | "del" | "ins"; text: string };

export function drawDiff(before: string, after: string): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (const { kind, text } of diffRuns(before, after)) {
    fragment.append(
      kind === "same"
        ? document.createTextNode(text)
        : Object.assign(document.createElement(kind), { textContent: text }),
    );
  }

  return fragment;
}

export function diffRuns(before: string, after: string): Run[] {
  for (const split of [words, lines]) {
    const left = split(before);
    const right = split(after);

    if (left.length * right.length <= MAX_CELLS) {
      return runs(left, right);
    }
  }

  return [
    { kind: "del", text: before },
    { kind: "ins", text: after },
  ];
}

function words(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Longest common subsequence, walked back from the end so each run comes out in order. */
function runs(left: string[], right: string[]): Run[] {
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);

  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] =
        left[i] === right[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const found: Run[] = [];
  const push = (kind: Run["kind"], text: string) => {
    const last = found.at(-1);

    if (last?.kind === kind) {
      last.text += text;
    } else {
      found.push({ kind, text });
    }
  };
  let i = 0;
  let j = 0;

  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      push("same", left[i++]);
      j++;
    } else if (
      j >= right.length ||
      (i < left.length && table[(i + 1) * width + j] >= table[i * width + j + 1])
    ) {
      push("del", left[i++]);
    } else {
      push("ins", right[j++]);
    }
  }

  return found;
}
