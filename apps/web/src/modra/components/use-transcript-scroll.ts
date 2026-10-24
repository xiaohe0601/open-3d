import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type UIEvent,
  type WheelEvent,
  type TouchEvent,
} from "react";

export const TRANSCRIPT_BOTTOM_THRESHOLD = 80;
export function transcriptBottomDistance(node: Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop">) {
  return Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop);
}

/** Following is user intent measured before growth, not a consequence of a new scrollHeight. */
export function useTranscriptScroll(active: boolean, contentVersion: unknown) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const readingTop = useRef(0);
  const geometry = useRef({ height: 0, client: 0 });
  const userIntent = useRef(false);
  const programmedTop = useRef<number | null>(null);
  const nested = useRef(new WeakMap<HTMLElement, { following: boolean; top: number }>());
  const frame = useRef<number | null>(null);
  const returnAnimation = useRef<{ from: number; startedAt: number } | null>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const [showReturn, setShowReturn] = useState(false);

  useLayoutEffect(() => {
    const node = viewportRef.current;
    const content = contentRef.current;
    if (!node || !content) return;
    const update = () => {
      frame.current = null;
      if (!active || !node.checkVisibility() || !node.clientHeight) return;
      // Disable browser anchoring: a growing tool or image must not choose a different reading position.
      const animation = returnAnimation.current;
      const progress = animation ? Math.min(1, (performance.now() - animation.startedAt) / 320) : 1;
      const bottom = Math.max(0, node.scrollHeight - node.clientHeight);
      // Retarget against live content so streamed output cannot interrupt the return animation.
      const top = animation
        ? animation.from + (bottom - animation.from) * (1 - (1 - progress) ** 3)
        : following.current
          ? bottom
          : readingTop.current;
      if (node.scrollTop !== top) {
        node.scrollTop = top;
        programmedTop.current = node.scrollTop;
      }
      readingTop.current = node.scrollTop;
      geometry.current = { height: node.scrollHeight, client: node.clientHeight };
      for (const list of node.querySelectorAll<HTMLElement>("[data-ai-proposals]")) {
        let position = nested.current.get(list);
        if (!position) {
          position = { following: true, top: list.scrollTop };
          nested.current.set(list, position);
        }
        list.scrollTop = following.current && position.following ? list.scrollHeight : position.top;
        position.top = list.scrollTop;
      }
      if (animation && progress < 1) schedule();
      else returnAnimation.current = null;
      setShowReturn(!animation && transcriptBottomDistance(node) > TRANSCRIPT_BOTTOM_THRESHOLD);
    };
    const schedule = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(update);
    };
    scheduleRef.current = schedule;
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    resize.observe(content);
    const mutation = new MutationObserver(schedule);
    mutation.observe(content, { subtree: true, characterData: true, childList: true, attributes: true });
    schedule();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      returnAnimation.current = null;
      scheduleRef.current = () => {};
    };
  }, [active]);

  useLayoutEffect(() => scheduleRef.current(), [contentVersion]);

  function noteIntent() {
    returnAnimation.current = null;
    userIntent.current = true;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }

  function inScrollableProposals(target: EventTarget) {
    const list = (target as HTMLElement).closest<HTMLElement>("[data-ai-proposals]");
    return list && list.scrollHeight > list.clientHeight;
  }

  return {
    viewportRef,
    contentRef,
    showReturn,
    onWheel: (event: WheelEvent) => {
      if (!inScrollableProposals(event.target)) noteIntent();
    },
    onTouchMove: (event: TouchEvent) => {
      if (!inScrollableProposals(event.target)) noteIntent();
    },
    onPointerDown: (event: PointerEvent) => {
      if (event.target === viewportRef.current) noteIntent();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (
        event.target === viewportRef.current &&
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      )
        noteIntent();
    },
    onScrollCapture: (event: UIEvent) => {
      const node = viewportRef.current;
      if (!active || !node?.checkVisibility()) return;
      const target = event.target as HTMLElement;
      if (target !== node) {
        if (target.matches("[data-ai-proposals]"))
          nested.current.set(target, {
            following: transcriptBottomDistance(target) <= TRANSCRIPT_BOTTOM_THRESHOLD,
            top: target.scrollTop,
          });
        return;
      }
      if (returnAnimation.current && !userIntent.current) return;
      if (!userIntent.current && programmedTop.current === node.scrollTop) {
        programmedTop.current = null;
        return;
      }
      programmedTop.current = null;
      const unchangedLayout =
        geometry.current.height === node.scrollHeight && geometry.current.client === node.clientHeight;
      // Layout-generated scroll events must never turn a suspended reader into a follower.
      if (userIntent.current || (unchangedLayout && node.scrollTop !== readingTop.current)) {
        following.current = transcriptBottomDistance(node) <= TRANSCRIPT_BOTTOM_THRESHOLD;
        readingTop.current = node.scrollTop;
        geometry.current = { height: node.scrollHeight, client: node.clientHeight };
        userIntent.current = false;
      }
      setShowReturn(transcriptBottomDistance(node) > TRANSCRIPT_BOTTOM_THRESHOLD);
    },
    returnToBottom: (transferFocus: boolean) => {
      const node = viewportRef.current;
      if (!node) return;
      following.current = true;
      userIntent.current = false;
      returnAnimation.current =
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches && transcriptBottomDistance(node) > 1
          ? { from: node.scrollTop, startedAt: performance.now() }
          : null;
      if (!returnAnimation.current) node.scrollTop = node.scrollHeight;
      readingTop.current = node.scrollTop;
      geometry.current = { height: node.scrollHeight, client: node.clientHeight };
      setShowReturn(false);
      if (transferFocus) node.focus({ preventScroll: true });
      scheduleRef.current();
    },
  };
}