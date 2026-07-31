import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { hotkeysHabilitados } from './CallView';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

// Regresión del 31-jul: los atajos 1/2/3/L/W seguían vivos con el
// "¿Borrar esta nota?" abierto porque el guard solo miraba role="dialog" y
// Radix marca los AlertDialog con role="alertdialog". Un 1 por costumbre
// confirmaba —y despachaba a Dropi— el pedido tapado por el overlay.
describe('hotkeysHabilitados', () => {
  afterEach(cleanup);

  it('deja correr el atajo cuando no hay overlay ni campo de texto enfocado', () => {
    expect(hotkeysHabilitados(document.body, document)).toBe(true);
  });

  it('BLOQUEA el atajo con un AlertDialog de Radix abierto', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>¿Borrar esta nota?</AlertDialogTitle>
          <AlertDialogDescription>No se puede deshacer.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );
    // Premisa del bug: Radix NO usa role="dialog" acá.
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // El foco vive en un BUTTON del diálogo, así que el guard por tagName no salva.
    expect(hotkeysHabilitados(document.activeElement, document)).toBe(false);
  });

  it('BLOQUEA el atajo con un Dialog de Radix abierto', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Editar pedido</DialogTitle>
          <DialogDescription>Datos del cliente.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(hotkeysHabilitados(document.activeElement, document)).toBe(false);
  });

  it('BLOQUEA el atajo con un campo de texto enfocado', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(hotkeysHabilitados(document.activeElement, document)).toBe(false);
    input.remove();
  });
});
