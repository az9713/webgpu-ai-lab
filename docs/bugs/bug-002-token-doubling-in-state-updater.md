# Bug 002 — Chat response tokens doubled by StrictMode

**Status:** Fixed  
**Component:** `src/App.tsx`, `setChatMessages` state updater  
**Severity:** High — all LLM responses are garbled and unreadable

---

## Symptom

After Bug 001 was fixed and the LLM became operational, every word in the assistant's response appeared twice:

```
assistant: WebGPUGPU is is a a technology technology that that enables enables
developers developers to to create create high high-performance-performance
graphics graphics and and compute compute applications applications...
```

The pattern is perfectly consistent — every token is duplicated with no exceptions.

---

## Root cause

### The mutation

The state updater for streaming chat deltas mutated the previous message object in-place:

```tsx
setChatMessages((prev) => {
  const clone = [...prev];                    // shallow copy of the array
  const last  = clone[clone.length - 1];      // same object reference as prev's last element
  if (last && last.role === "assistant") {
    last.content += data.delta;               // ← MUTATION: modifies the original object
  } else {
    clone.push({ role: "assistant", content: data.delta });
  }
  return clone;
});
```

`[...prev]` creates a new array but does **not** deep-clone the objects inside. `last` is the same object that lives in the previous state. Calling `last.content += data.delta` modifies it directly.

### How StrictMode surfaces the bug

React 18 StrictMode **double-invokes state updater functions** in development to detect side effects. The same updater function is called twice with the same `prev` argument:

**First invocation:**
- `clone` = new array (shallow copy of `prev`)
- `last` = `prev[prev.length - 1]` (the actual object)
- `last.content` mutated: `"WebGPU"` → `"WebGPUWebGPU"`
- React discards this result

**Second invocation (same `prev`):**
- `clone` = new array (shallow copy of `prev`)
- `last` = `prev[prev.length - 1]` — **the same object**, now already carrying `"WebGPUWebGPU"` from the first invocation
- `last.content` mutated again: `"WebGPUWebGPU"` → `"WebGPUWebGPUWebGPU"`... wait, but the delta is `"WebGPU"` — so:
  - First invocation: `"" + "WebGPU"` = `"WebGPU"` (written to the shared object)
  - Second invocation: `"WebGPU" + "WebGPU"` = `"WebGPUWebGPU"` (React uses this result)

The second result `"WebGPUWebGPU"` becomes the committed state. Every subsequent delta follows the same pattern, producing doubled output.

### Why this only fires in development

React only double-invokes updaters in StrictMode (development). In production, the updater runs once and the mutation goes undetected — but the code is still technically wrong because it violates React's requirement that state updaters be pure functions.

---

## Fix

Replace the in-place mutation with an immutable update. Create a new message object instead of modifying the existing one:

**Before (`src/App.tsx`):**

```tsx
setChatMessages((prev) => {
  const clone = [...prev];
  const last  = clone[clone.length - 1];
  if (last && last.role === "assistant") {
    last.content += data.delta;               // mutates shared object
  } else {
    clone.push({ role: "assistant", content: data.delta });
  }
  return clone;
});
```

**After (`src/App.tsx`):**

```tsx
setChatMessages((prev) => {
  const clone = [...prev];
  const last  = clone[clone.length - 1];
  if (last && last.role === "assistant") {
    clone[clone.length - 1] = { ...last, content: last.content + data.delta }; // new object
  } else {
    clone.push({ role: "assistant", content: data.delta });
  }
  return clone;
});
```

`{ ...last, content: last.content + data.delta }` creates a new object. The original `last` object (which `prev` still holds a reference to) is never touched. Both StrictMode invocations start from an unmodified `prev` and produce the same result — as required.

---

## Verification

After the fix, streaming output is clean:

```
assistant: WebGPU is a technology that enables web applications to access
graphics processing units (GPUs) and other graphics hardware, even when
they're running on the web...
```

---

## Prevention

React's rule: **state updater functions must be pure**. A pure updater:

1. Does not modify any object or array from `prev`
2. Returns the same value if called multiple times with the same arguments
3. Has no side effects (no API calls, no `console.log`, no mutations)

When updating nested state (arrays of objects), always create new objects at every level that changes:

```tsx
// ❌ Mutates existing object
clone[i].field += value;

// ✅ Creates a new object
clone[i] = { ...clone[i], field: clone[i].field + value };
```

StrictMode's double-invocation is specifically designed to catch violations of this rule. If you see duplicated output in a streaming UI in development, an in-place mutation in a state updater is the most likely cause.
