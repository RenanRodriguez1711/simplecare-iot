# Credenciales — Inventario de Secretos

Este archivo documenta **qué secretos existen y dónde están guardados**, pero NO contiene los valores reales.  
Los valores reales deben guardarse en un gestor de contraseñas (Bitwarden, 1Password, o similar).

---

## Credenciales activas

### VPS Hostinger
| Campo | Descripción |
|---|---|
| Host | `2.24.196.49` |
| Usuario | `root` |
| Contraseña | En gestor de contraseñas — entrada: "VPS SimpleCare IoT" |
| Acceso | SSH |

---

### Traccar — Panel de administración
| Campo | Descripción |
|---|---|
| URL | `http://2.24.196.49:8082` |
| Usuario admin | `admin` |
| Contraseña | En gestor de contraseñas — entrada: "Traccar SimpleCare" |
| Nota | Cambiar contraseña por defecto si no se ha hecho |

---

### Meta / WhatsApp Cloud API
| Campo | Descripción |
|---|---|
| App | App SimpleCare en Meta for Developers |
| Phone Number ID | `1294512040418742` |
| Token de acceso | **Caduca periódicamente** — renovar en Meta Developer Portal |
| Ubicación actual | Hardcodeado en `/root/traccar.xml` en el VPS |
| Ubicación pendiente | Migrar a variable de entorno |
| Cómo renovar | Meta Developer Portal → tu app → WhatsApp → API Setup → Step 1 |

**⚠️ El token de WhatsApp expira. Si WhatsApp deja de enviar mensajes, lo primero que hay que verificar es si el token expiró.**

---

### GitHub
| Campo | Descripción |
|---|---|
| Repositorio | `https://github.com/RenanRodriguez1711/simplecare-iot` |
| Visibilidad | Privado |
| Acceso | Cuenta GitHub del propietario |

---

## Tokens de municipios (cuando se implemente multi-tenant)

Cada municipio tendrá un token único generado con:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Guardar cada token en el gestor de contraseñas con la entrada: "Dashboard SimpleCare — [Nombre Municipio]"

---

## Rotación de credenciales

| Credencial | Frecuencia de rotación | Responsable |
|---|---|---|
| Token WhatsApp (temporal) | Cada 24 horas (automático Meta) | Renovar manualmente cuando expire |
| Token WhatsApp (sistema) | Cada 60 días | Configurar token de sistema en Meta Business |
| Contraseña VPS | Anual o ante sospecha de compromiso | SimpleCare admin |
| Contraseña Traccar | Anual | SimpleCare admin |
| Tokens municipios | Solo ante solicitud o sospecha | SimpleCare admin |

---

## Qué hacer si se compromete una credencial

**Token WhatsApp comprometido:**
1. Revocar en Meta Developer Portal → invalidar token
2. Generar nuevo token
3. Actualizar `/root/write_config.py` en el VPS
4. Ejecutar `python3 /root/write_config.py && docker cp /root/traccar.xml traccar:/opt/traccar/conf/traccar.xml && docker restart traccar`

**Contraseña VPS comprometida:**
1. Cambiar contraseña desde el panel de Hostinger
2. Revisar logs de acceso: `last` y `journalctl -u ssh`
3. Verificar que no se crearon usuarios nuevos: `cat /etc/passwd`

**Token de municipio comprometido:**
1. Generar nuevo token
2. Actualizar en la base de datos del backend
3. Notificar al municipio con la nueva URL
