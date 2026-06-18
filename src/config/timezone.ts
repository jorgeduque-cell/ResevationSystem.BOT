// =========================================================
// TIMEZONE - Fija la zona horaria del proceso a Bogotá.
// DEBE importarse ANTES que cualquier otro módulo que use fechas.
//
// Todo el sistema (date.ts: nowBogota / getNextDateForDay / toIsoDate y la
// ventana horaria del AvailabilityEngine) asume que la hora LOCAL del proceso
// es la de Bogotá. En la máquina de desarrollo (UTC-5) eso se cumple, pero un
// VPS en UTC corre las fechas 5h: en la madrugada de Bogotá un objetivo de
// lunes termina cayendo en domingo (y las horas quedan corridas). Forzamos la
// TZ para que el servidor se comporte igual que local, sin tocar ninguna
// configuración de días de búsqueda ni de horarios.
// =========================================================

process.env.TZ = 'America/Bogota';
