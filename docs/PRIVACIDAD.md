# Privacidad y Anonimización — SimpleCare IoT

## Marco legal

Este sistema almacena y procesa datos de adultos mayores. En Chile, la **Ley 21.719 de Protección de Datos Personales** (vigente desde 2025) regula el tratamiento de datos personales.

**Principio clave aplicado:** los datos verdaderamente anonimizados — donde es técnicamente imposible reidentificar a la persona — no se consideran datos personales y por tanto no están sujetos a las restricciones de la ley.

El modelo de anonimización de SimpleCare está diseñado para cumplir este principio.

---

## Modelo de anonimización

### Qué información llega al sistema
Traccar recibe del dispositivo EV07B:
- ID del dispositivo (IMEI o ID interno)
- Nombre del dispositivo (configurado en Traccar, ej: "Miguel")
- Coordenadas GPS precisas (ej: -33.456789, -70.648312)
- Tipo de evento y timestamp

### Qué se almacena en la base de datos
| Campo almacenado | Técnica | Resultado |
|---|---|---|
| ID dispositivo | SHA256 → primeros 16 chars hex | `d4735e3a265e16ee` |
| Nombre del dispositivo | **No se almacena** | — |
| Coordenadas GPS | Redondeo a 2 decimales | `-33.46, -70.65` |
| Tipo de alarma | Sin transformación | `sos`, `fall`, `low_battery` |
| Timestamp | Sin transformación | `2026-06-20 14:32:10` |

### Qué información se presenta al municipio
- El ID anónimo se trunca a **8 caracteres** en el dashboard (ej: `d4735e3a`)
- Coordenadas con precisión de ~200 metros (no permite ubicar una dirección exacta)
- Tipos de alerta y fechas
- Conteos y tendencias agregadas

---

## Por qué SHA256 es suficiente

El IMEI o ID interno del dispositivo es un número que está vinculado al hardware físico. Un hash SHA256 de este valor:
- Es **irreversible** matemáticamente (no se puede obtener el IMEI original desde el hash)
- Permite **correlacionar eventos** del mismo dispositivo sin saber de quién es
- Evita que incluso el municipio pueda identificar a un individuo específico

La lista de correspondencia IMEI ↔ hash existe **únicamente** en los registros internos de SimpleCare (no en la base de datos del dashboard).

---

## Por qué 2 decimales en GPS

| Decimales | Precisión aproximada |
|---|---|
| 6 (GPS real) | ~0.1 metros — dirección exacta |
| 4 | ~11 metros — edificio exacto |
| 3 | ~111 metros — calle aproximada |
| **2** | **~1.1 km — zona del barrio** |

Con 2 decimales es imposible determinar en qué casa o edificio vive o se encontraba la persona. Solo permite identificar zonas de mayor frecuencia de alertas a nivel de barrio.

---

## Datos que NUNCA se almacenan

- Nombre del adulto mayor
- RUT o identificación
- Dirección exacta
- Número de teléfono
- Datos de los contactos de emergencia
- Fotos o grabaciones
- Historial de movimiento continuo (solo eventos de alarma y conexión/desconexión)

---

## Retención de datos

- Los datos anonimizados se almacenan indefinidamente por defecto (útiles para análisis de tendencias a largo plazo)
- **Pendiente definir:** política formal de retención máxima (recomendado: 2 años)
- **Pendiente implementar:** mecanismo de borrado automático por antigüedad

---

## Responsabilidades

| Actor | Rol |
|---|---|
| **SimpleCare** | Responsable del tratamiento. Gestiona dispositivos, configura el sistema, mantiene la correspondencia IMEI → municipio |
| **Municipio** | Receptor de datos anonimizados agregados. No puede reidentificar individuos |
| **Familia del adulto mayor** | Otorga consentimiento al activar el servicio. Recibe alertas directas vía WhatsApp |

---

## Consentimiento

El adulto mayor (o su tutor/familia) debe aceptar:
1. Que el dispositivo registra su ubicación GPS aproximada
2. Que los datos de uso se comparten de forma anonimizada con el municipio para fines de planificación social
3. Que los contactos registrados recibirán alertas directas en caso de emergencia

**Pendiente:** documento formal de consentimiento informado para firmar al entregar el dispositivo.
