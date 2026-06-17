// Theme-aware CallGuard logo. The wordmark in the default SVGs is near-black,
// so on dark surfaces we swap to a light-wordmark variant. Both images carry
// the sizing classes; only one is ever in flow (the other is display:none via
// the `dark` class on <html>), so layout is unaffected.
export function Logo({
  variant = 'horizontal',
  className = '',
  alt = 'CallGuard AI',
}: {
  variant?: 'horizontal' | 'stacked';
  className?: string;
  alt?: string;
}) {
  return (
    <>
      <img src={`/callguard-logo-${variant}.svg`} alt={alt} className={`${className} dark:hidden`} />
      <img src={`/callguard-logo-${variant}-dark.svg`} alt={alt} className={`${className} hidden dark:block`} />
    </>
  );
}
