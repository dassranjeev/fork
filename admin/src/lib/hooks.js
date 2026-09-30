import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-toastify";
import { errorMessage, http } from "./api";

export function useDebounced(value, delay = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

/**
 * Fetch data. `path` null/undefined disables the request.
 *   const { data, loading, error, reload } = useFetch('/admin/roles')
 * Refetches when path or params (deep compared) change. `refreshMs` polls.
 */
export function useFetch(path, params, { refreshMs, initial = null } = {}) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState(null);
  const key = JSON.stringify([path, params]);
  const seq = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!path) return;
      const id = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const res = await http.get(path, params);
        if (id === seq.current) {
          setData(res);
          setError(null);
        }
      } catch (e) {
        if (id === seq.current) setError(errorMessage(e));
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!refreshMs || !path) return undefined;
    const t = setInterval(() => load(true), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, load, path]);

  return { data, loading, error, reload: () => load(), setData };
}

/**
 * Server-side paginated list state for <DataTable>.
 *   const list = usePagedList('/admin/orders', { filters: { status: '' } })
 *   <ListToolbar list={list} /> <DataTable {...list.tableProps} columns=... />
 */
export function usePagedList(path, { limit = 20, filters = {}, sortBy, sortDir = "DESC", refreshMs } = {}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(limit);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ sortBy, sortDir });
  const [filterState, setFilterState] = useState(filters);
  const debouncedSearch = useDebounced(search);

  const params = useMemo(
    () => ({ page, limit: pageSize, search: debouncedSearch || undefined, sortBy: sort.sortBy, sortDir: sort.sortBy ? sort.sortDir : undefined, ...filterState }),
    [page, pageSize, debouncedSearch, sort, filterState]
  );
  const { data, loading, error, reload } = useFetch(path, params, { refreshMs });

  useEffect(() => setPage(1), [debouncedSearch, filterState, pageSize]);

  const setFilter = useCallback((name, value) => setFilterState((f) => ({ ...f, [name]: value })), []);
  const setFilters = useCallback((patch) => setFilterState((f) => ({ ...f, ...patch })), []);
  const toggleSort = useCallback(
    (col) => setSort((s) => (s.sortBy === col ? { sortBy: col, sortDir: s.sortDir === "ASC" ? "DESC" : "ASC" } : { sortBy: col, sortDir: "ASC" })),
    []
  );

  const rows = data?.data ?? (Array.isArray(data) ? data : []);
  const meta = data?.meta ?? { page, limit: pageSize, total: rows.length, totalPages: 1 };

  return {
    rows,
    meta,
    loading,
    error,
    reload,
    params,
    search,
    setSearch,
    filters: filterState,
    setFilter,
    setFilters,
    setPage,
    setPageSize,
    sort,
    toggleSort,
    tableProps: { rows, meta, loading, sort, onSort: toggleSort, onPage: setPage, onLimit: setPageSize },
  };
}

/**
 * Small form state helper.
 *   const f = useForm({ name: '', active: true });
 *   <TextInput {...f.bind('name')} />  f.values  f.set('a', 1)  f.reset(next)
 */
export function useForm(initial = {}) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const set = useCallback((name, value) => setValues((v) => ({ ...v, [name]: value })), []);
  const bind = useCallback(
    (name) => ({ name, value: values[name] ?? "", onChange: (val) => set(name, val), error: errors[name] }),
    [values, errors, set]
  );
  const bindCheck = useCallback((name) => ({ name, checked: !!values[name], onChange: (val) => set(name, val) }), [values, set]);
  const reset = useCallback((next = initial) => {
    setValues(next);
    setErrors({});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { values, setValues, set, bind, bindCheck, reset, errors, setErrors };
}

/** Wrap an async submit with loading + toast handling. */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, { success, onDone } = {}) => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast.success(success);
      if (onDone) onDone(r);
      return r;
    } catch (e) {
      toast.error(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

/** Persist a piece of UI state (filters, tab) in localStorage. */
export function useLocalState(key, initial) {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(`forksy.ui.${key}`);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`forksy.ui.${key}`, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, [key, v]);
  return [v, setV];
}
