import { useMemo } from "react";
import { useFetch } from "../../lib/hooks";

/** restaurant + city lookups used to turn ids into names in the order desk. */
export function useLookups() {
  const rest = useFetch("/admin/restaurants", { limit: 100 });
  const cities = useFetch("/admin/cities", { limit: 100 });
  const restaurants = rest.data?.data || [];
  const cityList = cities.data?.data || [];
  const restaurantName = useMemo(() => Object.fromEntries(restaurants.map((r) => [r.id, r.name])), [restaurants]);
  const cityName = useMemo(() => Object.fromEntries(cityList.map((c) => [c.id, c.name])), [cityList]);
  return { restaurants, cities: cityList, restaurantName, cityName };
}
