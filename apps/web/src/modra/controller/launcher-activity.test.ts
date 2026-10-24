import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { LauncherActivityController } from "./launcher-activity";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(open = true) {
  const changed = vi.fn();
  const controller = new LauncherActivityController(changed);
  controller.setOpen(open);
  controller.report("generating");
  controller.report("completed");
  return { controller, changed };
}

test("acknowledges visible completion after exactly three seconds", () => {
  const { changed } = setup();
  vi.advanceTimersByTime(2999);
  expect(changed).toHaveBeenLastCalledWith("completed");
  vi.advanceTimersByTime(1);
  expect(changed).toHaveBeenLastCalledWith("idle");
});

test("retains hidden completion indefinitely and acknowledges it on opening", () => {
  const { controller, changed } = setup(false);
  vi.advanceTimersByTime(30_000);
  expect(changed).toHaveBeenLastCalledWith("completed");
  controller.setOpen(true);
  expect(changed).toHaveBeenLastCalledWith("idle");
  controller.report("completed");
  expect(changed).toHaveBeenLastCalledWith("idle");
});

test("hiding during the countdown retains completion until the next opening", () => {
  const { controller, changed } = setup();
  vi.advanceTimersByTime(2500);
  controller.setOpen(false);
  vi.advanceTimersByTime(10_000);
  expect(changed).toHaveBeenLastCalledWith("completed");
  controller.setOpen(true);
  expect(changed).toHaveBeenLastCalledWith("idle");
});

test("an old countdown cannot override a newly generating request", () => {
  const { controller, changed } = setup();
  vi.advanceTimersByTime(2999);
  controller.report("generating");
  vi.advanceTimersByTime(10_000);
  expect(changed).toHaveBeenLastCalledWith("generating");
});

test("a new completion receives its own full countdown", () => {
  const { controller, changed } = setup();
  vi.advanceTimersByTime(2900);
  controller.report("generating");
  controller.report("completed");
  vi.advanceTimersByTime(100);
  expect(changed).toHaveBeenLastCalledWith("completed");
  vi.advanceTimersByTime(2900);
  expect(changed).toHaveBeenLastCalledWith("idle");
});

test.each(["error", "idle"] as const)("%s cancels the previous completion timer", (next) => {
  const { controller, changed } = setup();
  vi.advanceTimersByTime(2000);
  controller.report(next);
  const count = changed.mock.calls.length;
  vi.advanceTimersByTime(5000);
  expect(changed).toHaveBeenLastCalledWith(next);
  expect(changed).toHaveBeenCalledTimes(count);
});

test("opening while generating does not acknowledge or cancel generation", () => {
  const changed = vi.fn();
  const controller = new LauncherActivityController(changed);
  controller.report("generating");
  controller.setOpen(true);
  expect(changed).toHaveBeenLastCalledWith("generating");
  controller.report("completed");
  vi.advanceTimersByTime(3000);
  expect(changed).toHaveBeenLastCalledWith("idle");
});

test("duplicate reports do not restart the countdown and disposal clears it", () => {
  const { controller, changed } = setup();
  vi.advanceTimersByTime(2000);
  controller.report("completed");
  vi.advanceTimersByTime(1000);
  expect(changed).toHaveBeenLastCalledWith("idle");
  controller.report("generating");
  controller.report("completed");
  controller.dispose();
  const count = changed.mock.calls.length;
  vi.advanceTimersByTime(5000);
  expect(changed).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});