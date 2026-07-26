# Onboarding — Incorporar un nuevo municipio

Proceso paso a paso para dar de alta a un municipio como cliente del sistema SimpleCare IoT.

---

## Antes de la reunión con el municipio

- [ ] Tener al menos un dispositivo EV07B configurado y probado
- [ ] Confirmar que el flujo WhatsApp funciona (plantilla aprobada, contacto de prueba recibe mensaje)
- [ ] Preparar el dashboard con datos de demostración

---

## Paso 1 — Definir el clientId del municipio

Elegir un identificador corto en minúsculas, sin espacios ni caracteres especiales.

Ejemplos: `santiago`, `maipu`, `lascondes`, `pudahuel`

Este ID se usará en la URL del dashboard y para filtrar sus datos.

---

## Paso 2 — Generar el token secreto

En el VPS, generar un token aleatorio seguro:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Guardar el token en un lugar seguro (gestor de contraseñas interno de SimpleCare).  
El municipio accederá al dashboard con esta URL:

```
http://2.24.196.49:3000/dashboard/maipu?token=TOKEN_GENERADO
```

*(cuando esté configurado el subdominio: `https://panel.simplecare.cl/dashboard/maipu?token=TOKEN_GENERADO`)*

---

## Paso 3 — Registrar el municipio en el backend

**Pendiente implementar:** actualmente el backend no tiene multi-tenant. Al implementarlo, agregar en la tabla de clientes:

```sql
INSERT INTO clients (client_id, nombre, token, logo_path)
VALUES ('maipu', 'Municipalidad de Maipú', 'TOKEN_AQUI', '/logos/maipu.png');
```

---

## Paso 4 — Subir el logo del municipio

Copiar el logo al VPS:

```bash
scp logo_maipu.png root@2.24.196.49:/opt/simplecare/public/logos/maipu.png
```

El dashboard lo carga automáticamente desde `/logos/:clientId.png`.

**Formato recomendado:** PNG con fondo transparente, mínimo 200x200px.

---

## Paso 5 — Registrar los dispositivos en Traccar

Por cada dispositivo que se entregará al municipio:

1. Abrir panel Traccar: `http://2.24.196.49:8082`
2. Ir a **Dispositivos** → `+`
3. Nombre: nombre de la persona (ej: "Juan Pérez") — solo para uso interno de SimpleCare
4. Identificador: IMEI del dispositivo
5. Guardar

**Importante:** el nombre del dispositivo en Traccar es información interna de SimpleCare. **Nunca** se almacena en la base de datos del dashboard (se anonimiza en el webhook).

---

## Paso 6 — Asociar dispositivos al municipio

**Pendiente implementar panel admin.** Mientras tanto, registrar manualmente la correspondencia:

| IMEI | device_hash (SHA256[:16]) | Municipio |
|---|---|---|
| 123456789012345 | d4735e3a265e16ee | maipu |

Para obtener el hash de un IMEI:
```bash
node -e "console.log(require('crypto').createHash('sha256').update('123456789012345').digest('hex').slice(0,16))"
```

---

## Paso 7 — Configurar notificaciones WhatsApp en Traccar

Por cada dispositivo:

1. En Traccar: **Notificaciones** → `+`
2. Tipo: Alarma
3. Canal: WhatsApp
4. Número de teléfono del contacto de emergencia: `56912345678` (con código país, sin `+`)
5. Asignar al dispositivo correspondiente
6. Guardar

---

## Paso 8 — Probar el flujo completo

1. Activar alarma SOS en el dispositivo
2. Verificar que:
   - [ ] El evento aparece en el panel Traccar
   - [ ] El contacto recibe el WhatsApp
   - [ ] El evento queda registrado en la DB (`/opt/simplecare/events.db`)
   - [ ] El evento aparece en el dashboard del municipio

---

## Paso 9 — Entregar acceso al municipio

Enviar al referente del municipio:
- URL del dashboard con token
- Instrucciones básicas de uso (filtros, fechas, exportar CSV)
- Contacto de soporte SimpleCare

---

## Checklist final

- [ ] clientId definido
- [ ] Token generado y guardado en gestor de contraseñas
- [ ] Logo subido al servidor
- [ ] Dispositivos registrados en Traccar
- [ ] Dispositivos asociados al municipio en la DB
- [ ] Notificaciones WhatsApp configuradas por dispositivo
- [ ] Prueba end-to-end exitosa
- [ ] Dashboard accesible con la URL del municipio
- [ ] Acceso entregado al referente municipal
