import {
  addDays,
  addHours,
  addMilliseconds,
  addMonths,
  addYears,
  differenceInDays,
  differenceInMonths,
  endOfDay,
  isFirstDayOfMonth,
  isLastDayOfMonth,
  startOfDay,
} from "date-fns";
import type { Collection, HassEntity } from "home-assistant-js-websocket";
import { getCollection } from "home-assistant-js-websocket";
import memoizeOne from "memoize-one";
import {
  calcDate,
  calcDateDifferenceProperty,
  calcDateProperty,
} from "../common/datetime/calc_date";
import type { DateRange } from "../common/datetime/calc_date_range";
import { calcDateRange } from "../common/datetime/calc_date_range";
import { formatTime24h } from "../common/datetime/format_time";
import { formatNumber } from "../common/number/format_number";
import { normalizeValueBySIPrefix } from "../common/number/normalize-by-si-prefix";
import { groupBy } from "../common/util/group-by";
import type { HomeAssistant } from "../types";
import { fileDownload } from "../util/file_download";
import type {
  Statistics,
  StatisticsMetaData,
  StatisticsUnitConfiguration,
  StatisticValue,
} from "./recorder";
import {
  fetchStatistics,
  getDisplayUnit,
  getStatisticMetadata,
  VOLUME_UNITS,
} from "./recorder";

export const ENERGY_COLLECTION_KEY_PREFIX = "energy_";

// All collection keys created this session
const energyCollectionKeys = new Set<string | undefined>();

// Validate that a string is a valid energy collection key.
export function validateEnergyCollectionKey(key: string | undefined) {
  if (!key?.startsWith(ENERGY_COLLECTION_KEY_PREFIX)) {
    throw new Error(
      `Collection keys must start with ${ENERGY_COLLECTION_KEY_PREFIX}.`
    );
  }
}

export const emptyGridSourceEnergyPreference =
  (): GridSourceTypeEnergyPreference => ({
    type: "grid",
    stat_energy_from: null,
    stat_energy_to: null,
    stat_cost: null,
    stat_compensation: null,
    entity_energy_price: null,
    number_energy_price: null,
    entity_energy_price_export: null,
    number_energy_price_export: null,
    name: null,
  });

export const emptySolarSourceEnergyPreference =
  (): SolarSourceTypeEnergyPreference => ({
    type: "solar",
    stat_energy_from: null,
    name: null,
  });

export const emptyBatterySourceEnergyPreference =
  (): BatterySourceTypeEnergyPreference => ({
    type: "battery",
    stat_energy_from: null,
    stat_energy_to: null,
    name: null,
  });

export const emptyGasSourceEnergyPreference =
  (): GasSourceTypeEnergyPreference => ({
    type: "gas",
    stat_energy_from: null,
    unit_of_measurement: null,
    name: null,
  });

export const emptyWaterSourceEnergyPreference =
  (): WaterSourceTypeEnergyPreference => ({
    type: "water",
    stat_energy_from: null,
    unit_of_measurement: null,
    name: null,
  });

export interface GridSourceTypeEnergyPreference {
  type: "grid";
  stat_energy_from: string | null;
  stat_energy_to: string | null;
  stat_cost: string | null;
  stat_compensation: string | null;
  entity_energy_price: string | null;
  number_energy_price: string | null;
  entity_energy_price_export: string | null;
  number_energy_price_export: string | null;
  name: string | null;
}

export interface SolarSourceTypeEnergyPreference {
  type: "solar";
  stat_energy_from: string | null;
  name: string | null;
}

export interface BatterySourceTypeEnergyPreference {
  type: "battery";
  stat_energy_from: string | null;
  stat_energy_to: string | null;
  name: string | null;
}

export interface GasSourceTypeEnergyPreference {
  type: "gas";
  stat_energy_from: string | null;
  unit_of_measurement: string | null;
  name: string | null;
}

export interface WaterSourceTypeEnergyPreference {
  type: "water";
  stat_energy_from: string | null;
  unit_of_measurement: string | null;
  name: string | null;
}

export type EnergyPreference =
  | DeviceConsumptionEnergyPreference
  | GridSourceTypeEnergyPreference
  | SolarSourceTypeEnergyPreference
  | BatterySourceTypeEnergyPreference
  | GasSourceTypeEnergyPreference
  | WaterSourceTypeEnergyPreference;

export interface DeviceConsumptionEnergyPreference {
  type: "device_consumption";
  stat_consumption: string | null;
  name: string | null;
}

export interface EnergyInfo {
  cost_sensors: Record<string, string>;
  device_consumption: Array<DeviceConsumptionEnergyPreference>;
  energy_sources: Array<EnergyPreference>;
  solar_source: Array<SolarSourceTypeEnergyPreference>;
  battery_source: Array<BatterySourceTypeEnergyPreference>;
  gas_source: Array<GasSourceTypeEnergyPreference>;
  water_source: Array<WaterSourceTypeEnergyPreference>;
  grid_source: Array<GridSourceTypeEnergyPreference>;
  last_reset: string | null;
}

export async function getEnergyInfo(
  hass: HomeAssistant
): Promise<EnergyInfo | null> {
  const collection = await getEnergyCollection(hass);
  return collection.state;
}

export async function updateEnergyInfo(
  hass: HomeAssistant,
  energy: EnergyInfo
): Promise<EnergyInfo> {
  const collection = await getEnergyCollection(hass);
  collection.setState(energy, true);
  return energy;
}

async function getEnergyCollection(hass: HomeAssistant) {
  const collection = getCollection<EnergyInfo>(
    hass.connection,
    ENERGY_COLLECTION_KEY_PREFIX,
    (_conn, onChange) => import("./websocket/energy").then(({ subscribeEnergyInfo }) =>
      subscribeEnergyInfo(_conn, onChange)
    )
  );
  return collection;
}

export async function deleteEnergyInfo(hass: HomeAssistant): Promise<void> {
  const collection = await getEnergyCollection(hass);
  collection.setState(null, true);
}

export interface PreferredEnergyPanel {
  energy_sources: Array<{
    type: string;
    stat_energy_from?: string | null;
  }>;
}

export const getPreferredEnergyPanel = memoizeOne(
  (energy: EnergyInfo | null): PreferredEnergyPanel | null => {
    if (!energy) {
      return null;
    }

    return {
      energy_sources: energy.energy_sources.map((source) => ({
        type: source.type,
        ...(source.type !== "device_consumption" && "stat_energy_from" in source
          ? { stat_energy_from: source.stat_energy_from }
          : {}),
      })),
    };
  }
);

export interface EnergyStats {
  start: Date;
  end: Date;
  gridSolarProduction?: number;
  gridImport?: number;
  gridExport?: number;
  gridConsumption?: number;
  solarProduction?: number;
  solarConsumptionBattery?: number;
  solarConsumptionHome?: number;
  batteryIn?: number;
  batteryOut?: number;
  batteryConsumption?: number;
  gasConsumption?: number;
  waterConsumption?: number;
  deviceConsumption?: Record<string, number>;
}

export async function getEnergyStats(
  hass: HomeAssistant,
  energyInfo: EnergyInfo,
  startDate: Date,
  endDate: Date,
  period: "day" | "month" | "year" = "day",
  statistic_ids?: string[]
): Promise<Map<string, StatisticValue[]> | null> {
  // Collect all statistic IDs
  const ids: Set<string> = new Set(statistic_ids || []);

  if (energyInfo.grid_source) {
    energyInfo.grid_source.forEach((source) => {
      if (source.stat_energy_from) {
        ids.add(source.stat_energy_from);
      }
      if (source.stat_energy_to) {
        ids.add(source.stat_energy_to);
      }
    });
  }

  if (energyInfo.solar_source) {
    energyInfo.solar_source.forEach((source) => {
      if (source.stat_energy_from) {
        ids.add(source.stat_energy_from);
      }
    });
  }

  if (energyInfo.battery_source) {
    energyInfo.battery_source.forEach((source) => {
      if (source.stat_energy_from) {
        ids.add(source.stat_energy_from);
      }
      if (source.stat_energy_to) {
        ids.add(source.stat_energy_to);
      }
    });
  }

  if (energyInfo.device_consumption) {
    energyInfo.device_consumption.forEach((source) => {
      if (source.stat_consumption) {
        ids.add(source.stat_consumption);
      }
    });
  }

  if (energyInfo.gas_source) {
    energyInfo.gas_source.forEach((source) => {
      if (source.stat_energy_from) {
        ids.add(source.stat_energy_from);
      }
    });
  }

  if (energyInfo.water_source) {
    energyInfo.water_source.forEach((source) => {
      if (source.stat_energy_from) {
        ids.add(source.stat_energy_from);
      }
    });
  }

  if (ids.size === 0) {
    return null;
  }

  const statistics = await fetchStatistics(
    hass,
    Array.from(ids),
    startDate,
    endDate,
    period
  );

  return statistics;
}

export async function calculateStatisticsSumInPeriod(
  hass: HomeAssistant,
  statIds: string[],
  startDate: Date,
  endDate: Date
): Promise<number | null> {
  if (!statIds.length) {
    return null;
  }

  const statistics = await fetchStatistics(
    hass,
    statIds,
    startDate,
    endDate,
    "day"
  );

  let sum = 0;
  for (const values of statistics.values()) {
    for (const value of values) {
      if (value.sum !== null) {
        sum += value.sum;
      }
    }
  }
  return sum;
}

export function calculateStatisticsMetadata(
  statisticsData: Map<string, StatisticValue[]>,
  statIds: string[],
  startDate: Date,
  endDate: Date
): StatisticsMetaData | null {
  let sumValue = 0;
  let minValue: number | null = null;
  let maxValue: number | null = null;

  for (const statId of statIds) {
    const values = statisticsData.get(statId);

    if (!values) {
      continue;
    }

    for (const value of values) {
      if (value.sum !== null) {
        sumValue += value.sum;
      }

      if (value.min !== null) {
        if (minValue === null || minValue > value.min) {
          minValue = value.min;
        }
      }

      if (value.max !== null) {
        if (maxValue === null || maxValue < value.max) {
          maxValue = value.max;
        }
      }
    }
  }

  return {
    min: minValue,
    max: maxValue,
    sum: sumValue,
  };
}

export function getEnergyUnitsForDisplay(
  energyInfo: EnergyInfo,
  getDisplayUnitFunc: (statId: string) => string | null
): Record<string, string | null> {
  const units: Record<string, string | null> = {};

  if (energyInfo.grid_source) {
    energyInfo.grid_source.forEach((source) => {
      if (source.stat_energy_from) {
        units[source.stat_energy_from] = getDisplayUnitFunc(source.stat_energy_from);
      }
      if (source.stat_energy_to) {
        units[source.stat_energy_to] = getDisplayUnitFunc(source.stat_energy_to);
      }
    });
  }

  if (energyInfo.solar_source) {
    energyInfo.solar_source.forEach((source) => {
      if (source.stat_energy_from) {
        units[source.stat_energy_from] = getDisplayUnitFunc(source.stat_energy_from);
      }
    });
  }

  if (energyInfo.battery_source) {
    energyInfo.battery_source.forEach((source) => {
      if (source.stat_energy_from) {
        units[source.stat_energy_from] = getDisplayUnitFunc(source.stat_energy_from);
      }
      if (source.stat_energy_to) {
        units[source.stat_energy_to] = getDisplayUnitFunc(source.stat_energy_to);
      }
    });
  }

  if (energyInfo.device_consumption) {
    energyInfo.device_consumption.forEach((source) => {
      if (source.stat_consumption) {
        units[source.stat_consumption] = getDisplayUnitFunc(source.stat_consumption);
      }
    });
  }

  if (energyInfo.gas_source) {
    energyInfo.gas_source.forEach((source) => {
      if (source.stat_energy_from) {
        units[source.stat_energy_from] = getDisplayUnitFunc(source.stat_energy_from);
      }
    });
  }

  if (energyInfo.water_source) {
    energyInfo.water_source.forEach((source) => {
      if (source.stat_energy_from) {
        units[source.stat_energy_from] = getDisplayUnitFunc(source.stat_energy_from);
      }
    });
  }

  return units;
}

export function getStatisticIds(energyInfo: EnergyInfo): string[] {
  const ids: Set<string> = new Set();

  if (energyInfo.grid_source) {
    energyInfo.grid_source.forEach((source) => {
      if (source.stat_energy_from) {
        ids.add(source.stat_energy_from);
      }
      if (source.stat_energy_to) {
        ids.add(source.stat_energy_to);
      }
      if (source.stat_cost) {
        ids.add(source.stat_cost);
      }
      if (source.stat_compensation) {
        ids.add(source.stat_compensation);
      }
    });
  }

  if (energyInfo.solar_source) {
    energyInfo.solar_source.forEach((source) => {
      if (source.stat_energy_from) {
        ids.add(source.stat_energy_from);
      }
    });
  }

  if (energyInfo.battery_source) {
    energyInfo.battery_source.forEach((source) => {
      if (source.stat_energy_from) {
        ids.add(source.stat_energy_from);
      }
      if (source.stat_energy_to) {
        ids.add(source.stat_energy_to);
      }
    });
  }

  if (energyInfo.device_consumption) {
    energyInfo.device_consumption.forEach((source) => {
      if (source.stat_consumption) {
        ids.add(source.stat_consumption);
      }
    });
  }

  if (energyInfo.gas_source) {
    energyInfo.gas_source.forEach((source) => {
      if (source.stat_energy_from) {
        ids.add(source.stat_energy_from);
      }
    });
  }

  if (energyInfo.water_source) {
    energyInfo.water_source.forEach((source) => {
      if (source.stat_energy_from) {
        ids.add(source.stat_energy_from);
      }
    });
  }

  return Array.from(ids);
}

export interface EnergyData {
  start: Date;
  end: Date;
  totalGridImport: number;
  totalGridExport: number;
  totalSolarProduction: number;
  totalDeviceConsumption: number;
  totalBatteryIn: number;
  totalBatteryOut: number;
  totalGasConsumption: number;
  totalWaterConsumption: number;
  deviceConsumption: Record<string, number>;
  costs: Record<string, number>;
}

const getDateBoundaries = (date: Date): [Date, Date] => [
  startOfDay(date),
  endOfDay(date),
];

export const calculateEnergyMetrics = (
  stats: Map<string, StatisticValue[]>,
  energyInfo: EnergyInfo
): EnergyData => {
  const now = new Date();
  const [start, end] = getDateBoundaries(now);

  const data: EnergyData = {
    start,
    end,
    totalGridImport: 0,
    totalGridExport: 0,
    totalSolarProduction: 0,
    totalDeviceConsumption: 0,
    totalBatteryIn: 0,
    totalBatteryOut: 0,
    totalGasConsumption: 0,
    totalWaterConsumption: 0,
    deviceConsumption: {},
    costs: {},
  };

  const getLastValue = (values: StatisticValue[]): number | null => {
    if (!values.length) return null;
    return values[values.length - 1].sum || values[values.length - 1].value || null;
  };

  if (energyInfo.grid_source) {
    energyInfo.grid_source.forEach((source) => {
      if (source.stat_energy_from) {
        const value = getLastValue(stats.get(source.stat_energy_from) || []);
        if (value !== null) data.totalGridImport += value;
      }
      if (source.stat_energy_to) {
        const value = getLastValue(stats.get(source.stat_energy_to) || []);
        if (value !== null) data.totalGridExport += value;
      }
      if (source.stat_cost) {
        const value = getLastValue(stats.get(source.stat_cost) || []);
        if (value !== null) {
          data.costs[source.name || "grid"] = value;
        }
      }
    });
  }

  if (energyInfo.solar_source) {
    energyInfo.solar_source.forEach((source) => {
      if (source.stat_energy_from) {
        const value = getLastValue(stats.get(source.stat_energy_from) || []);
        if (value !== null) data.totalSolarProduction += value;
      }
    });
  }

  if (energyInfo.battery_source) {
    energyInfo.battery_source.forEach((source) => {
      if (source.stat_energy_from) {
        const value = getLastValue(stats.get(source.stat_energy_from) || []);
        if (value !== null) data.totalBatteryIn += value;
      }
      if (source.stat_energy_to) {
        const value = getLastValue(stats.get(source.stat_energy_to) || []);
        if (value !== null) data.totalBatteryOut += value;
      }
    });
  }

  if (energyInfo.device_consumption) {
    energyInfo.device_consumption.forEach((source) => {
      if (source.stat_consumption) {
        const value = getLastValue(stats.get(source.stat_consumption) || []);
        if (value !== null) {
          data.deviceConsumption[source.name || source.stat_consumption] = value;
          data.totalDeviceConsumption += value;
        }
      }
    });
  }

  if (energyInfo.gas_source) {
    energyInfo.gas_source.forEach((source) => {
      if (source.stat_energy_from) {
        const value = getLastValue(stats.get(source.stat_energy_from) || []);
        if (value !== null) data.totalGasConsumption += value;
      }
    });
  }

  if (energyInfo.water_source) {
    energyInfo.water_source.forEach((source) => {
      if (source.stat_energy_from) {
        const value = getLastValue(stats.get(source.stat_energy_from) || []);
        if (value !== null) data.totalWaterConsumption += value;
      }
    });
  }

  return data;
};

interface EnergyChartDataset {
  label: string;
  data: number[];
  backgroundColor?: string;
  borderColor?: string;
}

interface EnergyChartData {
  labels: string[];
  datasets: EnergyChartDataset[];
}

export const prepareEnergyChartData = (
  stats: Map<string, StatisticValue[]>,
  energyInfo: EnergyInfo,
  startDate: Date,
  endDate: Date
): EnergyChartData => {
  const labels: string[] = [];
  const datasets: Record<string, number[]> = {
    gridImport: [],
    gridExport: [],
    solarProduction: [],
    deviceConsumption: [],
    batteryIn: [],
    batteryOut: [],
    gasConsumption: [],
    waterConsumption: [],
  };

  // Generate date labels based on period
  let currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    labels.push(formatTime24h(currentDate));
    currentDate = addHours(currentDate, 1);
  }

  // Populate data for each metric
  if (energyInfo.grid_source) {
    energyInfo.grid_source.forEach((source) => {
      if (source.stat_energy_from) {
        const values = stats.get(source.stat_energy_from) || [];
        datasets.gridImport = values.map((v) => v.sum || v.value || 0);
      }
      if (source.stat_energy_to) {
        const values = stats.get(source.stat_energy_to) || [];
        datasets.gridExport = values.map((v) => v.sum || v.value || 0);
      }
    });
  }

  if (energyInfo.solar_source) {
    energyInfo.solar_source.forEach((source) => {
      if (source.stat_energy_from) {
        const values = stats.get(source.stat_energy_from) || [];
        datasets.solarProduction = values.map((v) => v.sum || v.value || 0);
      }
    });
  }

  if (energyInfo.battery_source) {
    energyInfo.battery_source.forEach((source) => {
      if (source.stat_energy_from) {
        const values = stats.get(source.stat_energy_from) || [];
        datasets.batteryIn = values.map((v) => v.sum || v.value || 0);
      }
      if (source.stat_energy_to) {
        const values = stats.get(source.stat_energy_to) || [];
        datasets.batteryOut = values.map((v) => v.sum || v.value || 0);
      }
    });
  }

  if (energyInfo.device_consumption) {
    energyInfo.device_consumption.forEach((source) => {
      if (source.stat_consumption) {
        const values = stats.get(source.stat_consumption) || [];
        datasets.deviceConsumption = values.map((v) => v.sum || v.value || 0);
      }
    });
  }

  if (energyInfo.gas_source) {
    energyInfo.gas_source.forEach((source) => {
      if (source.stat_energy_from) {
        const values = stats.get(source.stat_energy_from) || [];
        datasets.gasConsumption = values.map((v) => v.sum || v.value || 0);
      }
    });
  }

  if (energyInfo.water_source) {
    energyInfo.water_source.forEach((source) => {
      if (source.stat_energy_from) {
        const values = stats.get(source.stat_energy_from) || [];
        datasets.waterConsumption = values.map((v) => v.sum || v.value || 0);
      }
    });
  }

  return {
    labels,
    datasets: [
      {
        label: "Grid Import",
        data: datasets.gridImport,
        backgroundColor: "rgba(255, 99, 132, 0.5)",
        borderColor: "rgba(255, 99, 132, 1)",
      },
      {
        label: "Grid Export",
        data: datasets.gridExport,
        backgroundColor: "rgba(75, 192, 75, 0.5)",
        borderColor: "rgba(75, 192, 75, 1)",
      },
      {
        label: "Solar Production",
        data: datasets.solarProduction,
        backgroundColor: "rgba(255, 193, 7, 0.5)",
        borderColor: "rgba(255, 193, 7, 1)",
      },
      {
        label: "Device Consumption",
        data: datasets.deviceConsumption,
        backgroundColor: "rgba(156, 39, 176, 0.5)",
        borderColor: "rgba(156, 39, 176, 1)",
      },
    ],
  };
};

interface EnergyComparison {
  current: number;
  previous: number;
  percentageChange: number;
  trend: "up" | "down" | "neutral";
}

export const compareEnergyMetrics = (
  currentPeriod: EnergyData,
  previousPeriod: EnergyData
): Record<string, EnergyComparison> => {
  const calculateComparison = (current: number, previous: number): EnergyComparison => {
    const percentageChange = previous !== 0 ? ((current - previous) / previous) * 100 : 0;
    return {
      current,
      previous,
      percentageChange,
      trend: percentageChange > 0 ? "up" : percentageChange < 0 ? "down" : "neutral",
    };
  };

  return {
    gridImport: calculateComparison(
      currentPeriod.totalGridImport,
      previousPeriod.totalGridImport
    ),
    gridExport: calculateComparison(
      currentPeriod.totalGridExport,
      previousPeriod.totalGridExport
    ),
    solarProduction: calculateComparison(
      currentPeriod.totalSolarProduction,
      previousPeriod.totalSolarProduction
    ),
    deviceConsumption: calculateComparison(
      currentPeriod.totalDeviceConsumption,
      previousPeriod.totalDeviceConsumption
    ),
    batteryIn: calculateComparison(
      currentPeriod.totalBatteryIn,
      previousPeriod.totalBatteryIn
    ),
    batteryOut: calculateComparison(
      currentPeriod.totalBatteryOut,
      previousPeriod.totalBatteryOut
    ),
    gasConsumption: calculateComparison(
      currentPeriod.totalGasConsumption,
      previousPeriod.totalGasConsumption
    ),
    waterConsumption: calculateComparison(
      currentPeriod.totalWaterConsumption,
      previousPeriod.totalWaterConsumption
    ),
  };
};

export function formatEnergyData(value: number, unit: string = "kWh"): string {
  return formatNumber(value, "en", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).concat(` ${unit}`);
}

export interface EnergyTrendData {
  timestamp: Date;
  value: number;
}

export const calculateEnergyTrend = (
  data: EnergyTrendData[]
): { trend: "increasing" | "decreasing" | "stable"; slope: number } => {
  if (data.length < 2) {
    return { trend: "stable", slope: 0 };
  }

  // Simple linear regression
  const n = data.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  data.forEach((point, index) => {
    sumX += index;
    sumY += point.value;
    sumXY += index * point.value;
    sumX2 += index * index;
  });

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  return {
    trend: slope > 0.1 ? "increasing" : slope < -0.1 ? "decreasing" : "stable",
    slope,
  };
};

export interface PeakEnergyUsage {
  timestamp: Date;
  value: number;
  source: string;
}

export const findPeakEnergyUsage = (
  stats: Map<string, StatisticValue[]>
): PeakEnergyUsage | null => {
  let peak: PeakEnergyUsage | null = null;

  stats.forEach((values, source) => {
    values.forEach((stat) => {
      const value = stat.sum || stat.value || 0;
      if (!peak || value > peak.value) {
        peak = {
          timestamp: new Date(stat.start || stat.end || 0),
          value,
          source,
        };
      }
    });
  });

  return peak;
};

export const calculateEnergyDistribution = (
  energyData: EnergyData
): Record<string, number> => {
  const total =
    energyData.totalGridImport +
    energyData.totalSolarProduction +
    energyData.totalDeviceConsumption +
    energyData.totalGasConsumption +
    energyData.totalWaterConsumption;

  if (total === 0) {
    return {};
  }

  return {
    gridImport: (energyData.totalGridImport / total) * 100,
    solarProduction: (energyData.totalSolarProduction / total) * 100,
    deviceConsumption: (energyData.totalDeviceConsumption / total) * 100,
    gasConsumption: (energyData.totalGasConsumption / total) * 100,
    waterConsumption: (energyData.totalWaterConsumption / total) * 100,
  };
};

export interface EnergyAlert {
  id: string;
  type: "warning" | "error" | "info";
  message: string;
  timestamp: Date;
}

export const checkEnergyAlerts = (
  energyData: EnergyData,
  previousData: EnergyData
): EnergyAlert[] => {
  const alerts: EnergyAlert[] = [];

  const gridImportIncrease =
    energyData.totalGridImport - previousData.totalGridImport;
  if (gridImportIncrease > previousData.totalGridImport * 0.2) {
    alerts.push({
      id: "grid-import-spike",
      type: "warning",
      message: `Grid import has increased by ${formatNumber(gridImportIncrease)}`,
      timestamp: new Date(),
    });
  }

  const deviceConsumptionIncrease =
    energyData.totalDeviceConsumption - previousData.totalDeviceConsumption;
  if (deviceConsumptionIncrease > previousData.totalDeviceConsumption * 0.15) {
    alerts.push({
      id: "device-consumption-spike",
      type: "info",
      message: `Device consumption has increased by ${formatNumber(deviceConsumptionIncrease)}`,
      timestamp: new Date(),
    });
  }

  return alerts;
};

export const estimateEnergyCosts = (
  energyData: EnergyData,
  ratePerUnit: number
): number => {
  return energyData.totalGridImport * ratePerUnit;
};

export function getEnergySourceName(
  energySource: EnergyPreference | DeviceConsumptionEnergyPreference
): string {
  if (energySource.name) {
    return energySource.name;
  }
  return energySource.type;
}

export interface EnergySourceDisplay {
  id: string;
  name: string;
  type: string;
  icon: string;
}

export const getEnergySourceDisplayInfo = (
  energyInfo: EnergyInfo
): EnergySourceDisplay[] => {
  const sources: EnergySourceDisplay[] = [];

  if (energyInfo.grid_source) {
    energyInfo.grid_source.forEach((source) => {
      sources.push({
        id: source.stat_energy_from || "grid",
        name: source.name || "Grid",
        type: "grid",
        icon: "mdi:transmission-tower",
      });
    });
  }

  if (energyInfo.solar_source) {
    energyInfo.solar_source.forEach((source) => {
      sources.push({
        id: source.stat_energy_from || "solar",
        name: source.name || "Solar",
        type: "solar",
        icon: "mdi:white-balance-sunny",
      });
    });
  }

  if (energyInfo.battery_source) {
    energyInfo.battery_source.forEach((source) => {
      sources.push({
        id: source.stat_energy_from || "battery",
        name: source.name || "Battery",
        type: "battery",
        icon: "mdi:battery",
      });
    });
  }

  if (energyInfo.device_consumption) {
    energyInfo.device_consumption.forEach((source) => {
      sources.push({
        id: source.stat_consumption || "device",
        name: source.name || "Device",
        type: "device_consumption",
        icon: "mdi:devices",
      });
    });
  }

  if (energyInfo.gas_source) {
    energyInfo.gas_source.forEach((source) => {
      sources.push({
        id: source.stat_energy_from || "gas",
        name: source.name || "Gas",
        type: "gas",
        icon: "mdi:fire",
      });
    });
  }

  if (energyInfo.water_source) {
    energyInfo.water_source.forEach((source) => {
      sources.push({
        id: source.stat_energy_from || "water",
        name: source.name || "Water",
        type: "water",
        icon: "mdi:water",
      });
    });
  }

  return sources;
};

export async function exportEnergyDataAsCSV(
  hass: HomeAssistant,
  energyInfo: EnergyInfo,
  stats: Map<string, StatisticValue[]>
): Promise<void> {
  const rows: string[][] = [];
  const headers = ["Timestamp"];
  const statIdToName: Record<string, string> = {};

  // Build headers and stat ID to name mapping
  const addStatHeader = (statId: string | null, defaultName: string) => {
    if (statId && !headers.includes(defaultName)) {
      headers.push(defaultName);
      statIdToName[statId] = defaultName;
    }
  };

  if (energyInfo.grid_source) {
    energyInfo.grid_source.forEach((source) => {
      addStatHeader(source.stat_energy_from, source.name || "Grid Import");
      addStatHeader(source.stat_energy_to, source.name ? `${source.name} (Export)` : "Grid Export");
    });
  }

  if (energyInfo.solar_source) {
    energyInfo.solar_source.forEach((source) => {
      addStatHeader(source.stat_energy_from, source.name || "Solar Production");
    });
  }

  if (energyInfo.battery_source) {
    energyInfo.battery_source.forEach((source) => {
      addStatHeader(source.stat_energy_from, source.name ? `${source.name} (In)` : "Battery In");
      addStatHeader(source.stat_energy_to, source.name ? `${source.name} (Out)` : "Battery Out");
    });
  }

  if (energyInfo.device_consumption) {
    energyInfo.device_consumption.forEach((source) => {
      addStatHeader(source.stat_consumption, source.name || "Device Consumption");
    });
  }

  if (energyInfo.gas_source) {
    energyInfo.gas_source.forEach((source) => {
      addStatHeader(source.stat_energy_from, source.name || "Gas Consumption");
    });
  }

  if (energyInfo.water_source) {
    energyInfo.water_source.forEach((source) => {
      addStatHeader(source.stat_energy_from, source.name || "Water Consumption");
    });
  }

  // Add header row
  rows.push(headers);

  // Collect all timestamps
  const timestampSet = new Set<number>();
  stats.forEach((values) => {
    values.forEach((stat) => {
      if (stat.start) {
        timestampSet.add(new Date(stat.start).getTime());
      }
    });
  });

  // Sort timestamps
  const timestamps = Array.from(timestampSet).sort((a, b) => a - b);

  // Build data rows
  for (const timestamp of timestamps) {
    const row = [new Date(timestamp).toISOString()];

    for (let i = 1; i < headers.length; i++) {
      let value = "";
      stats.forEach((values) => {
        const stat = values.find((s) => {
          const statStart = s.start ? new Date(s.start).getTime() : 0;
          return statStart === timestamp;
        });
        if (stat && (stat.sum !== null || stat.value !== null)) {
          value = String(stat.sum !== null ? stat.sum : stat.value);
        }
      });
      row.push(value);
    }

    rows.push(row);
  }

  // Convert to CSV
  const csv = rows.map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");

  // Download
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  fileDownload(url, "energy.csv");
};
