import { Suspense, useEffect, useState, type PropsWithChildren } from "react";

export default function LoadOnOpen({ isOpen, children }: PropsWithChildren<{ isOpen: boolean }>) {
  const [hasOpened, setHasOpened] = useState(isOpen);
  useEffect(() => {
    if (isOpen) setHasOpened(true);
  }, [isOpen]);

  // Once mounted, the dialog can finish its exit animation and keep its state.
  return isOpen || hasOpened ? <Suspense fallback={null}>{children}</Suspense> : null;
}
