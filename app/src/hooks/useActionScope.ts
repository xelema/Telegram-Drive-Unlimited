import { useCallback, useLayoutEffect, useRef } from 'react';

/** A pending action belongs to one mounted account/view generation. */
export function useActionScope(key: string | null) {
    const scope = useRef({ key, revision: 0, mounted: true });
    if (scope.current.key !== key) {
        scope.current = { key, revision: scope.current.revision + 1, mounted: true };
    }
    useLayoutEffect(() => {
        scope.current.mounted = true;
        return () => { scope.current.mounted = false; scope.current.revision++; };
    }, []);
    return useCallback(() => {
        const revision = scope.current.revision;
        return () => key !== null && scope.current.mounted
            && scope.current.key === key && scope.current.revision === revision;
    }, [key]);
}
