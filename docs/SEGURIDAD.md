# Seguridad — SimpleCare IoT

## Estado actual

Este documento describe las medidas de seguridad implementadas, las brechas conocidas y las mejoras planificadas. El sistema está en **etapa de desarrollo/pruebas** — antes de incorporar clientes reales deben implementarse los puntos marcados como PENDIENTE.

---

## Medidas implementadas

### Red y firewall
- **UFW activo** en el VPS con reglas explícitas por puerto
- Solo los puertos necesarios están abiertos (22, 5187, 8082, 3000)
- La comunicación interna Docker → host está restringida a la subred `172.17.0.0/16`

### Anonimización de datos
- Los datos personales nunca se almacenan (ver `PRIVACIDAD.md`)
- SHA256 para IDs de dispositivos
- GPS redondeado a ~200m de precisión

### Proceso y disponibilidad
- Node.js gestionado por PM2 con auto-restart
- PM2 configurado para iniciar automáticamente al reiniciar el servidor

---

## Brechas conocidas — PENDIENTE

### Alta prioridad (antes del primer cliente real)

**1. Dashboard sin autenticación**
- Actualmente cualquiera con la IP y puerto puede ver el dashboard
- El código ya está preparado para token por URL (`/dashboard/:clientId?token=xxx`)
- **Acción:** implementar validación del token en el backend antes de servir datos

**2. Sin HTTPS**
- Toda la comunicación es HTTP sin cifrar
- Un atacante en la misma red puede interceptar los datos del dashboard
- **Acción:** configurar Nginx como reverse proxy + Certbot (Let's Encrypt) al registrar el subdominio `panel.simplecare.cl`

**3. Webhook sin autenticación**
- El endpoint `POST /webhook` acepta peticiones de cualquier origen
- Un atacante podría inyectar eventos falsos en la base de datos
- **Acción:** validar un header secreto compartido entre Traccar y Node.js, o restringir por IP origen (solo `172.17.0.1`)

**4. Panel Traccar expuesto**
- El panel de administración de Traccar está disponible en puerto 8082 sin HTTPS
- **Acción:** cambiar la contraseña por defecto si no se ha hecho, restringir acceso por IP o poner detrás de Nginx

### Media prioridad

**5. Token WhatsApp en archivo de texto plano**
- El token de Meta está hardcodeado en `/root/traccar.xml`
- Si alguien accede al servidor, puede ver y usar el token
- **Acción:** migrar a variables de entorno o secretos cifrados

**6. Sin rate limiting en la API**
- Los endpoints no tienen límite de peticiones
- **Acción:** implementar `express-rate-limit` en endpoints públicos

**7. Sin logs de auditoría**
- No hay registro de quién accedió al dashboard y cuándo
- **Acción:** agregar middleware de logging de accesos con timestamp e IP

**8. Backups**
- No hay backup automatizado de `events.db`
- **Acción:** configurar cron job que copie la base de datos a almacenamiento externo (S3 o similar) diariamente

### Baja prioridad

**9. SSH con contraseña**
- Verificar si el VPS tiene autenticación por clave SSH o solo contraseña
- **Acción recomendada:** deshabilitar login por contraseña, usar solo claves SSH

---

## Superficie de ataque

| Vector | Exposición | Estado |
|---|---|---|
| Puerto 22 (SSH) | Internet | Abierto — usar clave SSH |
| Puerto 3000 (dashboard) | Internet | Sin auth — PENDIENTE |
| Puerto 5187 (Traccar GPS) | Internet | Necesario para dispositivos |
| Puerto 8082 (Traccar panel) | Internet | Sin HTTPS — restringir acceso |
| POST /webhook | Red interna Docker | Sin validación de origen |
| events.db | Local VPS | Solo acceso root |

---

## Checklist de seguridad pre-producción

- [ ] Implementar token auth en todos los endpoints del dashboard
- [ ] Configurar HTTPS con Nginx + Certbot
- [ ] Restringir /webhook a IP interna solamente
- [ ] Cambiar contraseña admin de Traccar
- [ ] Configurar backup automático de events.db
- [ ] Implementar rate limiting en la API
- [ ] Mover el token de WhatsApp a variable de entorno
- [ ] Verificar que SSH use autenticación por clave
- [ ] Configurar rotación de logs PM2 (`pm2 install pm2-logrotate`)
