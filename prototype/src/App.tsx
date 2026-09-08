// Single route, three structural variants switched via ?variant= (issue #12).
import { PrototypeBar } from "./shared/PrototypeBar";
import { StateInspector } from "./shared/StateInspector";
import { useStore } from "./state/store";
import { TasmaVariant } from "./variants/tasma/TasmaVariant";
import { WarsztatVariant } from "./variants/warsztat/WarsztatVariant";
import { DziennikVariant } from "./variants/dziennik/DziennikVariant";

export function App() {
  const { variant } = useStore();
  return (
    <>
      {variant === "A" && <TasmaVariant />}
      {variant === "B" && <WarsztatVariant />}
      {variant === "C" && <DziennikVariant />}
      <StateInspector />
      <PrototypeBar />
    </>
  );
}
